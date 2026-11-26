/* ==========================================================================
   flood.js — 洪水演进实景层（吉隆「8·26」演示级沙盘）

   本层不改动 app.js 既有的态势叠加层，也不产出任何工程预测数字。
   它把用户发过的几份案例里的方法按各自适用的层次接起来：

   ④「二维高度场 / GPU 并行水流模拟」
       · RGBA8 ping-pong 状态纹理，每帧 3 个子步长推进
         「线性化浅水波方程」η_tt = c²∇²η（由浅水方程在小振幅下化简）
       · 半拉格朗日回溯做泡沫 / 湍流平流；干湿边界钳制 η 与 h≥0，
         湿区外速度归零，避免负水深与速度发散
       · 渲染网格比状态网格密，顶点用三次 B 样条（4 次双线性采样合并 16 taps）
         做**亚网格插值**，得到 C2 连续曲面而不是一格一跳的方块
       · 时间维用「带惯性的二阶涨水响应 + 后期退水」代替阶跃填充

   ②「防汛三维沙盘」  着色器画细节、命名材质、uniform 开关、时间轴驱动
   ⑤「医院孪生避坑」  锚点命名 / 数据口径一致性（实测数据、论文数值、视觉合成
                       三类在界面与诊断里分开标注）/ 包围盒取景
   ①「img2threejs」    碎冰与冰碛物由 makeSculpt(spec) 生成可编辑 THREE.Group，
                       挂 sculptRuntime，材质走命名色板
   ⑥「语义体素城市」  由 OSM 建筑、地形坡度、距沟道距离烘焙语义粗糙度，
                       驱动阻力、泡沫生成与浅水颜色，而不是全城一个系数

   ---------------------------------------------------------------------------
   数据的三层口径（务必分清，不允许混用）：
     A 真实数据：1001² DEM / Esri 影像 / 22 km 实测沟道 / OSM 建筑轮廓 /
                 model.json 一维沿程剖面 / 项目既有 arrival.bin + depth.bin
     B 论文数值：表 4 平均流深作为淹没水位包络（随情景滑块变化）
     C 视觉合成：地形约束的漫延包络、GPU 波面、泡沫、碎冰、飞溅、扬尘、
                 垂直放大系数——只影响观感，不产出流量/流速/到达时间
   ========================================================================== */

import * as THREE from './lib/three.module.js?v=20261114z';
import { makeSculpt } from './proc.js?v=20261114z';

/* ------------------------------ 可调常量 ------------------------------ */
const SW = 192, SH = 108;          // GPU 状态 / 淹没源网格
const MW = 288, MH = 162;          // 水面显示网格（1.5× 亚网格插值，兼顾连续性与帧率）
const SUBSTEPS = 3;                // 每帧子步长数，避免大 dt 造成动画卡顿
const T_SCALE = 1600.0;            // 源纹理 R 通道：T / 1600 → [0,1]
const T_FIELD = 470.0;             // 演示比例 1.0 对应的场时间（s）
const ETA_MAX = 8.0;               // 波面振幅上限（场景单位）
const REF_RISE = 240.0;            // 地形约束漫延的参考抬升（场景单位，视觉包络）
// 横向视觉展宽（口径 C）：对低淹没势做幂次抬升，等效把横向衰减长度放大约 1.6×。
// 在 bakeSource 烘焙阶段一次性生效，GPU 水面顶点 / GPU 波面状态 / CPU 碎冰粒子
// 读的是同一份展宽后的场，刚体与粒子不会脱节。仅便于观察，不代表实测淹没边界。
const POT_WIDEN_GAMMA = 0.60;
const RISE_TAU = 52.0;             // 涨水惯性时间常数（场秒）
const C2 = 0.22;                   // (c·dt/dx)²，二维 5 点拉普拉斯稳定域内
// 碎冰 / 冰碛物实例数（2026-11-15 用户：「主要是碎石块，没有泥石流的冲击感」）。
// 原来 260 + 220 = 480 块、半径 4~23 m，近景里等于一片漂在表面的乱石滩，
// 把「流体」的主体性全抢走了。压到 90 + 80、半径 3.5~13 m，并整体下沉，
// 让它们成为泥浆里露头的大块，而不是主角。
const N_ICE = 90, N_ROCK = 80;     // 碎冰 / 冰碛物实例数
const N_SPRAY = 900, N_DUST = 420; // 浪花飞溅 / 扬尘粒子数
// 「图 7 淹没范围」图层：阈值取 0.06（约 15/255）—— shape.bin 里 pot>0 的格点占
// 7.28%，其中只有 3.82% 达到 0.5 以上，用 0.5 做阈值会把整条主流裁掉一半。
// 0.06 圈出的正是从图 7 掩膜直接搬过来的那一圈外缘。
const EXTENT_THRESH = 0.06;
const EXTENT_OFFSET = 35;          // 贴地余量（场景单位），兜住山脊处的弦高差
const EXTENT_SDF_SPAN = 24;        // 距离场编码范围：±24 纹素 ≈ ±1.0 km，够包住整条主流

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* 涨水 / 退水：临界阻尼二阶响应带轻微过冲 → 惯性感、堆积与冲刷。
   与 GLSL 中 riseFn() 逐字对应，CPU 侧供碎冰浮沉与粒子落水判定使用。 */
function riseFn(dt) {
  if (dt <= 0) return 0;
  const x = dt / RISE_TAU;
  const r = 1 - Math.exp(-1.35 * x) * (Math.cos(1.05 * x) + 0.42 * Math.sin(1.05 * x));
  return clamp(r, 0, 1.16) * (1 - 0.30 * smoothstep(230, 470, dt));
}

function interpSeries(S, T, s) {
  const n = S.length;
  if (!n) return 0;
  if (s <= S[0]) return T[0];
  if (s >= S[n - 1]) return T[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const k = (s - S[lo]) / Math.max(S[hi] - S[lo], 1e-6);
  return T[lo] + (T[hi] - T[lo]) * k;
}

/* ---------------- 口岸下游外延（2026-11-14）----------------
   用户要求：「镜头到吉隆口岸为止，但洪水还要沿谷道再往外延伸」，并且「东西两支都漫」。
   图 7 的淹没包络到口岸就截止（shape.bin 的 pot 在口岸外约 300 m 归零），
   所以水到口岸是一刀切。口岸本身是个三叉口：东北是来水沟道，东南向是下游
   宽谷（实测一路下探 −57），西北向是一条缓升的谷道（吉隆镇方向）。
   做法：从口岸按真实 DEM 往**两个**方向各追一条谷底线（最陡下降，步长 80 m），
   自动挑「走得最远、且彼此分开」的两支 —— 不写死方位：
     · 候选 = 24 个初始方位各走一条；
     · 先取得分最高（距离 + 3×落差）的一条；
     · 再取与它终点相距 > 800 m 的最高分那条，作为第二支。
   沿线给窄带淹没势（中段最宽约 ±380 m、两端收窄、末端 30% 淡出），
   到达时间取「口岸 392 s + 沿程 72 s」。同时把这两圈写进「淹没范围」掩膜，
   免得水漫出框线。
   ⚠ 这是 D 层视觉外延：**不在论文图 7 的淹没范围内**，只用于演示观感；
   `?tail=0` 可整段关闭。 */
const TAIL_STEP = 80, TAIL_N = 22;
// ?tailfan=0 关掉「短支扇形漫溢」，回到原来两头收窄的纺锤形
const TAIL_FAN = typeof location === 'undefined' ||
                 new URLSearchParams(location.search).get('tailfan') !== '0';
// 外延水面允许画到比口岸高多少（场景单位，1.3× 夸张）。
// 200 ≈ 154 m 实高：只让水贴着坎脚铺成扇形，不让它翻上台地顶；
// ?tailclimb=0 回到严格值 120（≈92 m），西支会缩回一条细带。
const TAIL_RISE = (typeof location !== 'undefined' &&
                   new URLSearchParams(location.search).get('tailclimb') === '0') ? 120 : 200;

function buildPortTails(fs) {
  const P = fs.projector, port = fs.channel.port;
  const x0 = P.x(port[0]), z0 = P.z(port[1]);
  // 3×3 平均后的地形：单格 DEM 噪点会把「最陡下降」带进冲沟
  const H = (x, z) => (fs.displayY(x - 60, z) + fs.displayY(x, z - 60) + fs.displayY(x, z)
                     + fs.displayY(x + 60, z) + fs.displayY(x, z + 60)) / 5;
  const walk = (az0) => {
    const line = [{ x: x0, z: z0 }];
    let ang = az0 * Math.PI / 180, x = x0, z = z0, y = H(x, z);
    for (let i = 0; i < TAIL_N; i++) {
      let best = null;
      for (let da = -0.85; da <= 0.851; da += 0.17) {
        const a = ang + da;
        const xx = x + Math.cos(a) * TAIL_STEP, zz = z + Math.sin(a) * TAIL_STEP;
        const yy = H(xx, zz);
        const sc = yy + Math.abs(da) * 26;      // 轻微惩罚转角，避免左右摆
        if (!best || sc < best.sc) best = { sc, xx, zz, a, yy };
      }
      // 总爬升预算 65（≈50 m）：能顺着缓谷/台地漫出去，但翻不过山脊
      if (best.yy - H(x0, z0) > 65 && i > 2) break;
      x = best.xx; z = best.zz; y = best.yy; ang = best.a;
      line.push({ x, z });
    }
    return line;
  };
  /* 来水方向：末段沟道切向（指向口岸）。往这个方向漫等于让水倒流回沟里，
     候选分支里要排除这一带（±50°）。 */
  const cp = fs.chanPts, cn = cp.length;
  // 末段切向指向口岸（顺流），上游方向 = 反向
  const upAz = Math.atan2(cp[cn - 1].z - cp[cn - 6].z, cp[cn - 1].x - cp[cn - 6].x) + Math.PI;
  const angDiff = (a, b) => {
    const d = Math.abs(a - b) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
  };
  const cands = [];
  for (let az = 0; az < 360; az += 15) {
    const pts = walk(az);
    if (pts.length < 5) continue;               // 走不到 300 m 的方向不要
    const last = pts[pts.length - 1];
    /* 判定用**终点方位**而不是出发方位：最陡下降会拐弯，好几个出发角最后都
       汇进同一条谷 —— 拿出发角做「是否同一支」的判据会选中两个同款。 */
    const endAz = Math.atan2(last.z - z0, last.x - x0);
    if (angDiff(endAz, upAz) < 50 * Math.PI / 180) continue;   // 不往上游漫
    const d = Math.hypot(last.x - x0, last.z - z0);
    const drop = H(x0, z0) - H(last.x, last.z);
    cands.push({ endAz, pts, last, score: d + Math.max(0, drop) * 3 });
  }
  if (!cands.length) return [];
  cands.sort((x1, x2) => x2.score - x1.score);
  const a1 = cands[0];
  // 第二支：终点方位与第一支差 ≥70°，保证是另一侧的谷道
  const a2 = cands.find(c => angDiff(c.endAz, a1.endAz) >= 70 * Math.PI / 180);
  return a2 ? [a1.pts, a2.pts] : [a1.pts];
}

/* 某点到外延中线的距离 → 淹没势 / 到达时间。返回 null 表示不在外延内。
   baseT / spread（2026-11-15）：外延水的到达时间**必须从口岸自身的到达时刻起算**。
   原来写死 T = 392 + 72u，而口岸中轴实测约 451 s —— 扇区比口岸本体早 60 s 就
   有了一片水，蓝球（按可见水面取位）于是提前跳到口岸、冲击环也在那儿炸开，
   但上游 300~500 m 还是干沟，观感就是「球到了终点、路线还没到」。
   现在 baseT = 口岸中轴的单调到达时间，spread 取「到演示末尾还剩多少」的预算。 */
function tailProbe(tails, x, z, baseT, spread) {
  let bestPot = 0, bestU = 0;
  for (const line of tails) {
    const segs = line.length - 1;
    if (segs < 2) continue;
    let d0 = 1e9, u0 = 0;
    for (let i = 0; i < segs; i++) {
      const a = line[i], b = line[i + 1];
      const vx = b.x - a.x, vz = b.z - a.z;
      const L2 = vx * vx + vz * vz || 1;
      let t = ((x - a.x) * vx + (z - a.z) * vz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
      if (d < d0) { d0 = d; u0 = (i + t) / segs; }
    }
    /* 宽度：长支保持「中段宽、两头窄」的纺锤形；短支（被台地挡住的那一支）
       改成**扇形漫溢** —— 越往坎脚越宽、末端不收窄，水撞到坎之后左右铺开，
       而不是硬爬上高坎。长度不变（还是 540 m），只换形状，物理上说得通。 */
    const armLen = segs * TAIL_STEP;
    const fan = TAIL_FAN && armLen < 900;
    const half = fan ? 200 + 200 * u0            // 从 ±200 m 张到坎脚 ±400 m（总宽约 800 m）
                     : 170 + 210 * Math.sin(Math.PI * Math.min(1, u0 * 1.12));
    if (d0 > half) continue;
    // 扇形要是一整片水，不是只在中心一条芯：边缘衰减起点推后
    const lat = 1 - smoothstep(fan ? 0.62 : 0.45, 1.0, d0 / half);
    const end = 1 - smoothstep(fan ? 0.88 : 0.68, 1.0, u0);
    const pot = 0.32 * lat * end;
    if (pot > bestPot) { bestPot = pot; bestU = u0; }
  }
  if (bestPot < 0.02) return null;
  return { u: bestU, pot: bestPot, T: baseT + spread * bestU };
}

/* ---------------- 前缘速度台阶（2026-11-14，默认不做平滑） ----------------
   现象（用户）：洪水过「色琼断面」后速度突然变慢。
   量出来的原因（.workbuddy/tmp/…，见下）：剖面到达时刻只有三个锚点
   （论文正文 0 s@0 km、180 s@15 km、505 s@22 km，model.json → paperCalibration），
   profile 的 T 列就是这三点线性插值，于是前缘速度是**两段常数**：
     s = 14 002 → 14 974 m：ds/dT 恒为 83.35 m/s
     s ≥ 15 912 m：         ds/dT 恒为 21.54 m/s
   在 15 km 一步从 83.3 掉到 21.5（−74%）。
   ——这不是渲染问题，也不是模型突变：三条锚点**唯一确定**的就是两段常速。
   试过两种平滑（两段线性解在 ±1.4 km 内混合、五点 PCHIP），都不成立：
     · 混合法在断面上游把速度顶到 100 m/s 再急刹（因为两条线在分离，
       混合项的导数把斜率抵掉了一半）；
     · PCHIP 同样外凸（实测上游 93 m/s、下游 18 m/s），因为 T 的斜率不是单调的；
     · 根本矛盾：只要让减速**提前**开始，15 km 就一定晚于 180 s；
       只要让减速延后，22 km 就一定晚于 505 s。要两者都保住，速度只能是两段常数。
   所以默认保持论文口径不动。真要视觉上缓一档，得动锚点时刻（例如减速从
   色琼前 1.5 km 开始、色琼推到 183 s），那属于研究口径，需要用户拍板 ——
   把下面这个开关打开即可（FRONT_SMOOTH=true，band=1400 m），届时 15 km 处到达
   时间会变成约 183 s，0/505 s 两端不变。 */
const FRONT_SMOOTH = false;
const FRONT_BAND = 1400;

function smoothFrontT(S, T, anchorsS, anchorsT, band) {
  if (!Array.isArray(anchorsS) || !Array.isArray(anchorsT) ||
      anchorsS.length < 2 || anchorsS.length !== anchorsT.length) return null;
  // 校验：profile 必须就是锚点线性插值，否则不与未知数据源打架
  for (let i = 0; i < S.length; i++) {
    if (Math.abs(T[i] - interpSeries(anchorsS, anchorsT, S[i])) > 0.05) return null;
  }
  const out = new Float32Array(S.length);
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    let acc = T[i];
    for (let a = 1; a < anchorsS.length - 1; a++) {
      const A = anchorsS[a];
      const w = smoothstep(A - band, A + band, s);
      if (w <= 0 || w >= 1) continue;
      // 上游段（a-1→a）与下游段（a→a+1）在该点的取值
      const up = anchorsT[a - 1] + (anchorsT[a] - anchorsT[a - 1]) *
                 (s - anchorsS[a - 1]) / Math.max(anchorsS[a] - anchorsS[a - 1], 1e-6);
      const dn = anchorsT[a] + (anchorsT[a + 1] - anchorsT[a]) *
                 (s - anchorsS[a]) / Math.max(anchorsS[a + 1] - anchorsS[a], 1e-6);
      acc = up + (dn - up) * w;
    }
    out[i] = acc;
  }
  for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];  // 保单调
  return out;
}

/* ------------------------------ GLSL 公共片段 ------------------------------ */
const GLSL_COMMON = `
precision highp float;
#define T_SCALE 1600.0
#define ETA_MAX 8.0
#define RISE_TAU 52.0
#define C2 0.22
#define FRONT_W 10.0

float riseFn(float dt) {
  if (dt <= 0.0) return 0.0;
  float x = dt / RISE_TAU;
  float r = 1.0 - exp(-1.35*x) * (cos(1.05*x) + 0.42*sin(1.05*x));
  return clamp(r, 0.0, 1.16) * (1.0 - 0.30 * smoothstep(230.0, 470.0, dt));
}
/* 哈希值噪声：格点白噪声插值才是不规则湍流。
   2026-11-10 换成 Dave Hoskins 无三角函数 hash —— 旧的 fract(sin(dot(p,...))*43758)
   在 uv 随时间滚动、坐标变大后 sin 的小数精度被截断，会产生矩形面片与直角网格纹
   （WebGL 水面避坑的公认问题）。新 hash 只有乘加与 fract，大坐标下稳定。 */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0 - 2.0*f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  return 0.68*vnoise(p) + 0.32*vnoise(p*2.17);
}
float tAt(sampler2D src, vec2 uv) { return texture2D(src, uv).r * T_SCALE; }
`;

/* 三次 B 样条亚网格插值：利用硬件双线性把 16 次采样合并成 4 次，
   仍是 C2 连续曲面，消除 192×108 状态格在 384×216 显示网格上的格线跳变。
   （④ 要的是「连续曲面」，不是必须 16 taps；省下的 4× 顶点取数用于水面细节。） */
const GLSL_BICUBIC = `
vec4 bicubic(sampler2D tex, vec2 uv, vec2 texel) {
  vec2 p = uv / texel - 0.5;
  vec2 ip = floor(p), f = fract(p);
  vec2 w0 = pow(1.0 - f, vec2(3.0)) / 6.0;
  vec2 w1 = (3.0*f*f*f - 6.0*f*f + 4.0) / 6.0;
  vec2 w2 = (-3.0*f*f*f + 3.0*f*f + 3.0*f + 1.0) / 6.0;
  vec2 w3 = f*f*f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = ip - 0.5 + w1 / g0;
  vec2 h1 = ip + 1.5 + w3 / g1;
  vec4 t00 = texture2D(tex, vec2(h0.x, h0.y) * texel);
  vec4 t10 = texture2D(tex, vec2(h1.x, h0.y) * texel);
  vec4 t01 = texture2D(tex, vec2(h0.x, h1.y) * texel);
  vec4 t11 = texture2D(tex, vec2(h1.x, h1.y) * texel);
  return g0.y * (g0.x*t00 + g1.x*t10) + g1.y * (g0.x*t01 + g1.x*t11);
}
`;

/* ------------------------------ GPU 计算 pass ------------------------------ */
const QUAD_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const INIT_FRAG = GLSL_COMMON + `
uniform sampler2D uSource;
uniform float uTField;
varying vec2 vUv;
void main() {
  float T = tAt(uSource, vUv);
  float d = uTField - T;
  float front = (d > 0.0 && d < FRONT_W) ? (1.0 - smoothstep(0.0, FRONT_W, d)) : 0.0;
  // R/G=当前/上一帧波面（0.5 为零位），B=泡沫，A=湿区掩码
  gl_FragColor = vec4(0.5, 0.5, front * 0.55, 0.0);
}
`;

const STEP_FRAG = GLSL_COMMON + `
uniform sampler2D uState, uSource;
uniform vec2  uTexel;
uniform float uDt;        // 子步长（真实秒）
uniform float uTField;    // 场时间（s）
uniform float uPeak;      // 峰值淹没水位（场景单位）
uniform float uClock;     // 墙钟，用于湍流噪声
varying vec2 vUv;

float etaOf(vec4 s) { return (s.r - 0.5) * 2.0 * ETA_MAX; }
float etaPrevOf(vec4 s) { return (s.g - 0.5) * 2.0 * ETA_MAX; }
vec2 flowDir(vec2 uv) {
  float tx = tAt(uSource, uv + vec2(uTexel.x, 0.0)) - tAt(uSource, uv - vec2(uTexel.x, 0.0));
  float tz = tAt(uSource, uv + vec2(0.0, uTexel.y)) - tAt(uSource, uv - vec2(0.0, uTexel.y));
  return normalize(vec2(tx, tz) + vec2(1e-5, 0.0));
}
void main() {
  vec4  s  = texture2D(uState, vUv);
  float e  = etaOf(s);
  float ep = etaPrevOf(s);
  float l = etaOf(texture2D(uState, vUv - vec2(uTexel.x, 0.0)));
  float r = etaOf(texture2D(uState, vUv + vec2(uTexel.x, 0.0)));
  float u = etaOf(texture2D(uState, vUv + vec2(0.0, uTexel.y)));
  float d = etaOf(texture2D(uState, vUv - vec2(0.0, uTexel.y)));

  // ① 线性化浅水波方程：η_next = 2η - η_prev + C2·∇²η
  float lap = l + r + u + d - 4.0*e;
  float en = (2.0*e - ep + C2 * lap) * 0.986;

  vec4  src = texture2D(uSource, vUv);
  float T   = src.r * T_SCALE;
  float pot = src.g;
  float rough = src.b;
  float dSim = uTField - T;

  // ② 地形约束的淹没目标（宏观，来自真实场 + 论文表 4 水位）
  float hTarget = max(0.0, uPeak * pot * riseFn(dSim));
  // 流向 = 到达时间梯度；T 的拉普拉斯近似流线辐合 → 堆积 / 冲刷。
  // 只取 4 个邻居（而不是五处各算一次梯度），把计算 pass 的取数从 20 次降到 4 次。
  float tx0 = tAt(uSource, vUv - vec2(uTexel.x, 0.0));
  float tx1 = tAt(uSource, vUv + vec2(uTexel.x, 0.0));
  float tz0 = tAt(uSource, vUv - vec2(0.0, uTexel.y));
  float tz1 = tAt(uSource, vUv + vec2(0.0, uTexel.y));
  vec2  dir = normalize(vec2(tx1 - tx0, tz1 - tz0) + vec2(1e-5, 0.0));
  float lapT = tx1 + tx0 + tz1 + tz0 - 4.0 * T;
  hTarget *= clamp(1.0 - 0.018 * lapT, 0.78, 1.32);
  float wet = smoothstep(0.25, 1.4, hTarget);

  // ③ 前锋破碎带 / 波峰 / 粗糙地表持续注入波浪；干区不注能
  float front = (dSim > 0.0 && dSim < FRONT_W) ? (1.0 - smoothstep(0.0, FRONT_W, dSim)) : 0.0;
  vec2  np = vUv * vec2(46.0, 26.0) + dir * uClock * 1.35 + vec2(uClock*0.55, -uClock*0.31);
  float n  = fbm(np);
  float force = (front * 1.65 + wet * rough * 0.34) * (n - 0.5) * 2.0;
  en += force * uDt * 11.0 * wet;
  // 干湿边界：钳制波幅，绝不让 η 发散或把水推到负深度
  en = clamp(en, -ETA_MAX, ETA_MAX) * wet;

  // ④ 泡沫半拉格朗日平流 + 生成（前锋翻滚、波峰破碎、湿边）
  vec2 back = clamp(vUv - dir * uTexel * 1.7, uTexel*0.5, 1.0 - uTexel*0.5);
  float foamAdv = texture2D(uState, back).b;
  float crest = smoothstep(ETA_MAX*0.30, ETA_MAX*0.88, en) * wet;
  float gen = front*0.62 + crest*0.26 + wet*rough*0.018;
  // 泡沫衰减要快于前锋推进，否则整片水面会被刷成一张白饼
  float foam = clamp(foamAdv*0.900 + gen*uDt*3.0*wet, 0.0, 1.0);

  gl_FragColor = vec4(0.5 + en/(2.0*ETA_MAX), 0.5 + e/(2.0*ETA_MAX), foam, wet);
}
`;

/* ------------------------------ 水面渲染 ------------------------------ */
const WATER_VERT = GLSL_COMMON + GLSL_BICUBIC + `
uniform sampler2D uSource, uState;
uniform vec2  uSrcTexel;
uniform float uTField, uPeak, uClock, uExagToMeters, uSurge;
varying vec3  vWorld;
varying vec2  vUv, vFlow;
varying float vH, vEta, vFoam, vFront, vRough, vCore;

void main() {
  vUv = uv;
  vec4 src = bicubic(uSource, uv, uSrcTexel);   // 亚网格：C1 连续的 T / 淹没势 / 粗糙度
  float T = src.r * T_SCALE;
  float dSim = uTField - T;
  float h = max(0.0, uPeak * src.g * riseFn(dSim));
  /* 湿边羽化（2026-11-14）：shape.bin 的淹没势是 0/255 硬掩膜，bicubic 也只能把
     边界摊开一个网格（约 42 m），所以水面一直是一块「厚度均匀、边缘笔直、顶面
     平整」的板 —— 近景看就是一块土黄色多边形。这里用 4 抽样盒式模糊估一个
     「离岸远近」，让水深在岸线附近平滑收敛到 0：直边与垂直侧壁随之消失，
     水里也自然分出深浅两层。只改观感，不动 shape.bin 与任何水文数值。 */
  float potB = 0.25 * (
      texture2D(uSource, uv + vec2(uSrcTexel.x * 2.5, 0.0)).g
    + texture2D(uSource, uv - vec2(uSrcTexel.x * 2.5, 0.0)).g
    + texture2D(uSource, uv + vec2(0.0, uSrcTexel.y * 2.5)).g
    + texture2D(uSource, uv - vec2(0.0, uSrcTexel.y * 2.5)).g);
  h *= smoothstep(0.24, 0.80, potB);
  float wet = smoothstep(0.0, 1.1, h);

  // 流向由到达时间场梯度给出（真实场推导，不是手画箭头）
  float tx = tAt(uSource, uv + vec2(uSrcTexel.x, 0.0)) - tAt(uSource, uv - vec2(uSrcTexel.x, 0.0));
  float tz = tAt(uSource, uv + vec2(0.0, uSrcTexel.y)) - tAt(uSource, uv - vec2(0.0, uSrcTexel.y));
  vFlow = normalize(vec2(tx, tz) + vec2(1e-5, 0.0));

  vec4 st = texture2D(uState, uv);
  float eta  = (st.r - 0.5) * 2.0 * ETA_MAX;
  vH = h; vEta = eta; vFoam = st.b; vRough = src.b; vCore = src.a;
  /* 2026-11-15：vFront 不再乘 wet。wet = smoothstep(0,1.1,h) 在流头恰好趋 0
     （那儿 h 最小），乘上去等于「流头一出现就自己消失」—— 结果是水面永远是一张
     厚薄均匀的平板，看不出推进方向。改用淹没势 potB 兜住沟道范围：
     只要在沟道内、且刚被淹到，就给出完整的前锋权重。 */
  vFront = (dSim > 0.0 && dSim < FRONT_W)
    ? (1.0 - smoothstep(0.0, FRONT_W, dSim)) * smoothstep(0.14, 0.62, potB)
    : 0.0;

  vec3 p = position;
  // 高频波面：顺流向拉长的解析波纹，补足状态网格分辨率以下的细节
  vec2 w = vec2(p.x, p.z);
  // 低频相位扰动：纯正弦会织出「一块规则波纹布」，加入噪声后才像湍流
  // warp 用世界坐标而非网格 uv：uv 在近景局部几乎线性（变化尺度数百米），
  // 打散不了 26 m 周期的解析波纹；世界坐标 17~48 m 尺度才与波纹同量级。
  float warp = vnoise(w * 0.021) * 4.6 + vnoise(w * 0.058) * 1.7;
  float ph = dot(w, vFlow) * 0.055 - uClock * 2.35 + warp;
  float ripple = sin(ph)*0.62 + sin(ph*1.83 + 1.1)*0.28
               + sin(dot(w, vec2(-vFlow.y, vFlow.x))*0.11 + uClock*1.4 + warp*0.7)*0.34;
  p.y += (h + (eta*0.72 + ripple*0.60) * (0.35 + 0.65*min(h/18.0, 1.0))) * wet;
  /* 前锋涌浪（2026-11-15）：把流头抬成一道「墙」，后面再接一段回落 —— 这是
     「泥石流冲击感」最核心的一条形态线索（真实泥石流流头是隆起、陡立、向下游
     翻卷的，不是和后面一样厚的一层水）。
     包络用 dSim（到达后的场秒）而不是 h：流头正是 h 最小的位置，用 h 做权重
     会把涌浪自己乘没。potB 只用来把涌浪限制在沟道内，不爬到干坡上。
     幅度按场景单位给，与水深口径无关，仅改观感。
     2026-11-15 v2（用户「还是差点意思」）：v1 是一个平滑包络，在 76 m 一格的
     显示网格上只能插值出一段缓坡，近景读起来是「水面整体拱起」而不是「墙在推」。
     v2 加三件事，都不依赖网格密度：
       ① 包络取 0.55 次幂 —— 升到满高所需的水平距离从约 200 m 压到 40 m，
          插值后仍读成一道坎；
       ② 横向舌状 —— 沟心 potB≈1、岸侧≈0.3，前沿成为弧形舌而不是一条平直的坎；
       ③ 顶部翻卷 —— 沿流向的褶皱（波长约 74 m）叠横向起伏，墙顶不再是一条光边；
          再让墙顶沿流向略微前压，剖面「下陡上卷」，像正在往下游扑的水墙。 */
  float fw = (dSim > 0.0) ? (1.0 - smoothstep(0.0, FRONT_W * 2.8, dSim)) : 0.0;
  float fwBack = (dSim > 0.0) ? (1.0 - smoothstep(0.0, FRONT_W * 7.0, dSim)) : 0.0;
  float chan = smoothstep(0.14, 0.62, potB);
  float wall = pow(fw, 0.55);
  float tongue = 0.62 + 0.38 * smoothstep(0.30, 0.92, potB);
  float roll = sin(dot(w, vFlow) * 0.085 - uClock * 3.1)
             * cos(dot(w, vec2(-vFlow.y, vFlow.x)) * 0.045 + uClock * 0.7);
  float surge = uSurge * (wall + fwBack * 0.40) * chan * tongue
              + uSurge * 0.18 * roll * wall * chan;
  p.x -= vFlow.x * surge * 0.20;
  p.z -= vFlow.y * surge * 0.20;
  p.y += surge;
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const WATER_FRAG = GLSL_COMMON + `
uniform sampler2D uSat;       // Esri 真实影像：浅水折射透出阶地 / 农田 / 道路
uniform sampler2D uNormal0, uNormal1;  // three.js r160 官方真实水法线贴图（双相位）
uniform vec2  uNormalScale;   // 贴图在世界范围内的重复次数（等比例，避免拉伸）
uniform float uHasNormals, uNormalStrength, uFlowSpeed, uMuddy, uStreakK;
uniform vec3  uSun, uSky;
uniform float uClock, uAlpha, uExagToMeters, uPeak;
varying vec3  vWorld;
varying vec2  vUv, vFlow;
varying float vH, vEta, vFoam, vFront, vRough, vCore;

void main() {
  if (vH < 0.06) discard;                       // 干区不画，避免负水深硬边
  float depthM = vH * uExagToMeters;            // 还原成米（口径 B：论文流深）
  vec2  f = normalize(vFlow + vec2(1e-5, 0.0));
  vec2  fc = vec2(-f.y, f.x);
  // 一次噪声，湍流 / 泡沫 / 高光共用（软件渲染下噪声是主要开销）
  vec2 fp = vUv * vec2(128.0, 72.0) + f*uClock*2.1;
  float fn = fbm(fp) * 0.66 + 0.34 * vnoise(fp*2.3 - f*uClock*1.2);

  // --- 法线：几何坡度（dFdx/dFdy）叠加多尺度波纹坡度 → 明暗 / 反射随坡度变化 ---
  vec3 gN = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (gN.y < 0.0) gN = -gN;
  float warp = vnoise(vWorld.xz * 0.021) * 4.6 + vnoise(vWorld.xz * 0.058) * 1.7;
  /* 2026-11-14：warp 直接塞进 sin 的相位，等于把 sin 变成「噪声场的一层层等值线」——
     平水面上一放大就是一组同心年轮，整块水面看着像木板纹理。相位扰动只保留
     打散规则性所需的那一点（p1 ×0.55、p3 ×0.35），不再叠出同心圈。
     同一处还去掉 p3 里的 depthM*0.035：水深沿到达时间场从池心向外平滑递减，
     把它塞进 sin 就成了**一层层等深线**，正是「木板年轮」最粗的那组条纹。 */
  float p1 = dot(vWorld.xz, f)*0.055 - uClock*2.35 + warp*0.55;
  float p2 = dot(vWorld.xz, fc)*0.11 + uClock*1.40 + warp*0.45;
  float p3 = dot(vWorld.xz, f)*0.24 - uClock*3.60 + warp*0.35;
  // 屏幕空间抗锯齿：相位在相邻像素间变化过大时，这组波纹已低于采样能力，
  // 继续画只会叠成密集锯齿 / 同心摩尔纹（t=505 俯视全景实测很明显）→ 按梯度淡出。
  float aa1 = 1.0 - smoothstep(0.55, 1.45, fwidth(p1));
  float aa2 = 1.0 - smoothstep(0.55, 1.45, fwidth(p2));
  float aa3 = 1.0 - smoothstep(0.55, 1.45, fwidth(p3));
  vec2 slopeProc = f  * (cos(p1)*0.055*0.62*aa1 + cos(p1*1.83+1.1)*0.055*1.83*0.28*aa1
                         + cos(p3)*0.24*0.18*aa3)
                 + fc * (cos(p2)*0.11*0.34*aa2);
  // 幅度调制 + 不规则相位：纯等幅正弦会织出规则条纹；
  // 法线倾角控制在 ~10° 以内，避免成片过曝的规则亮带。
  slopeProc *= (0.45 + 1.05*fn);

  // --- 真实水法线贴图：Valve《Portal 2》Flow 法 / three.js r160 Water2 ---
  // 两张贴图以 half-cycle 相位差混合，专门消除「同一波一直重复」的抖动；
  // 采样 uv 按流向场 f 偏移，弯道处水纹顺着沟道走，不是全屏一个方向。
  float cycle = 0.15;
  float ph0 = fract(uClock * uFlowSpeed / cycle) * cycle;
  float ph1 = ph0 + cycle * 0.5;
  if (ph1 >= cycle) ph1 -= cycle;
  float flowLerp = abs(cycle * 0.5 - ph0) / (cycle * 0.5);
  vec2 baseUv = vUv * uNormalScale;
  vec3 c0 = texture2D(uNormal0, baseUv + f * ph0).rgb;
  // 第二层用不同缩放 + 横向漂移：同缩放只差相位（Water2 原法）在近景仍会
  // 看出同一组波纹重复；1.73× 叠加才真正打散周期性。
  vec3 c1 = texture2D(uNormal1, baseUv * 1.73 + fc * ph1 * 0.9).rgb;
  vec3 nc = mix(c0, c1, flowLerp);
  // 官方贴图通道约定是 R→x, G→z, B→y（不是标准切线空间法线），照抄 Water2
  vec3 texN = normalize(vec3(nc.r * 2.0 - 1.0, nc.b, nc.g * 2.0 - 1.0));
  vec2 slopeTex = vec2(texN.x, texN.z) * uNormalStrength;

  // 贴图细节为主、程序化波纹只留 25% 作大尺度基底（35% 在近景仍会织出条带）；
  // 贴图缺失时自动全量回退
  vec2 slope = slopeProc * mix(1.0, 0.25, uHasNormals) + slopeTex * uHasNormals;
  // 近景泥浆（uMuddy→1）：高频法线坡度衰减到 58%（原 78%）。
  // 2026-11-10：曾一度压到完全归零去"修斜纹"，但洋红像素量化证实
  // 斜纹属于山坡卫星影像（水面只占画布右下角约 3.8%），不是水面缺陷，
  // 故恢复为温和衰减，保留一点大尺度明暗起伏。
  // 2026-11-14：78% 衰减后近景水面完全没有明暗起伏，读起来是「一块棕色
  // 多边形」而不是「流动的浑水」。压到 58%，保留可辨的波面坡度。
  slope *= 1.0 - 0.58 * uMuddy;
  vec3 N = normalize(vec3(-slope.x*1.5, 1.0, -slope.y*1.5));
  // gN 是逐三角形常数，哪怕只借 10% 也会在俯视全景里显出细密的三角形人字纹；
  // 压到 3%，只保留极轻微的地形起伏感。
  // gN 是逐三角形常数，哪怕只借 10% 也会在俯视全景里显出细密的三角形人字纹；
  // 压到 3%，只保留极轻微的地形起伏感。
  N = normalize(mix(N, gN, 0.03));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSun);
  vec3 Hh = normalize(L + V);
  float ndh = max(dot(N, Hh), 0.0);
  // 高光不能一片过曝：乘以噪声遮罩，只在波峰的碎点上闪
  float detail = min(aa1, min(aa2, aa3));
  // 三档波瓣：96 次（针尖碎光）+ 20 次（中景波峰）+ 6 次（贴水面的宽阔「湿光」）。
  // 近景泥浆原来把高光整体乘 0.15，水面一点反光都没有 → 和山坡分不开。
  // 现在泥浆只衰减 60%，并由宽瓣承担「湿面」的主观感（碎光仍压着，不会成片过曝）。
  float spec = (pow(ndh, 96.0)*0.62 + pow(ndh, 20.0)*0.11 + pow(ndh, 6.0)*0.05) *
               (0.35 + 0.65*fn) * (0.30 + 0.70*detail) * (1.0 - 0.60*uMuddy);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  float diff = 0.58 + 0.42*max(dot(N, L), 0.0);

  // --- 水体颜色：冰川岩屑流（泥流）浑浊黄褐，不是清水的青灰镜面 ---
  // 上一版深水色偏青黑、再被 26% 天空菲涅尔与强高光洗一遍，近景就成了
  // 「灰白锡纸」，和两侧山坡混在一起，看不出灾害主体。这里改成暖泥色为主，
  // 卫星底图只透少量、高光压到碎点，让水面在绿色山谷里一眼可辨。
  // texSat 是 TextureLoader（flipY=true），而水面 uv 行 0 = 北 = DataTexture 行 0，
  // 两者 v 方向相反，这里必须翻回来，否则折射出来的是别处的山谷。
  vec2 ruv = vec2(vUv.x, 1.0 - vUv.y) + N.xz*0.0022*(1.0 + depthM*0.012);
  ruv = clamp(ruv, 0.002, 0.998);
  vec3 ground = texture2D(uSat, ruv).rgb;
  float ext = 1.0 - exp(-depthM * 0.105);
  // 2026-11-14：原浅泥黄 0.46/0.355/0.235、深泥褐 0.185/0.135/0.095 都是
  // 「同色系棕」，与两侧山坡的岩土影像几乎同色，缩到全景里就消失了。
  // 改成「浅处亮暖赭、主槽暗中性灰褐」——深浅之间拉开明度差，水面自己
  // 就能读成一条有中心的沟道；深处转中性而不是纯棕，才不会和山坡糊在一起。
  vec3 shallow = vec3(0.560, 0.400, 0.215);   // 浑浊泥黄（浅水 / 漫流边）
  vec3 deep    = vec3(0.120, 0.115, 0.112);   // 主槽：暗中性灰褐（高浓度悬浮液）
  vec3 body = mix(shallow, deep, clamp(depthM/18.0, 0.0, 1.0));
  // 卫星底图只透少量并压暖。泥浆模式进一步压到近乎不透明
  // （Unity HDRP「Dirty river」：降低 Absorption Distance）。
  // 注意：画面右侧那片斜纹是**山坡的卫星影像**，不是透过水面来的
  // （洋红像素量化：水面只占画布右下角约 3.8%），改这里不会也不必消掉它。
  // 近景泥浆几乎不透底（0.97~1.00），远景观感保持原样：卫星地面是棕色，
  // 透上来只会把水体的明度差抵消掉，越透越看不见。
  float waterMix = mix(0.72 + 0.28*ext, 0.97 + 0.03*ext, uMuddy);
  body = mix(ground * vec3(0.46, 0.42, 0.34), body, waterMix);
  // 悬浮泥沙（口径 C）：泥流颜色来自高浓度颗粒散射，不是清水表面吸收。
  // Unity HDRP「Dirty river」/ Vortex Suspension 同源做法。
  // 两层**各向同性** fbm 以不同速度沿流向滚动，靠时间产生流动感。
  // 曾用「沿流向低频 × 横向高频」的 fbm 做拉长流纹，那本质是一组平行条带，
  // 会把条纹换个方向请回来；各向同性才不会织出方向性纹理。
  // 悬浮泥沙（口径 C）：泥流颜色来自高浓度颗粒散射，不是清水表面吸收。
  // 2026-11-14：这一项原来整体乘 uMuddy，而 uMuddy 只在 900 m 内才接近 1，
  // 于是 2 km 外的水面**一丝色斑都没有**，成了一整块平涂色板（用户看到的就是这个）。
  // 改成 (0.45 + 0.55·uMuddy)：任何视距都保留约四成颗粒斑驳，近景再加强。
  float sediment = fbm(vWorld.xz * 0.035 + f * uClock * 0.40);
  float mudFlow = 0.60 * fbm(vWorld.xz * 0.012 + f * uClock * 0.85)
                + 0.40 * fbm(vWorld.xz * 0.026 - f * uClock * 0.55 + 11.7);
  body *= 1.0 - (0.45 + 0.55 * uMuddy) * (0.20 - 0.30 * sediment - 0.18 * mudFlow);
  /* 流速条纹（2026-11-15）：沿流向拉长的「泥沙流线」，是「这团东西在高速流动」
     最便宜的线索。11-14 曾直接做「沿流向低频 × 横向高频」的 fbm，结果是一组
     平行条带（等于把搓衣板换个方向）。这次的差别是先做**域扭曲**：
     世界坐标先被低频 fbm 推开 ±160 m，再去沿/横分解，条纹就顺着沟道拐弯、
     在弯道与汇流处自然断开。权重压在 0.85 以内，不改变水体基色。
     参考：各向异性泡沫 / 域扭曲（catlikecoding「Directional Flow」、
     three.js 海面分层做法）；这里只用它的坐标构造，不用它的波谱。 */
  vec2 dwarp = vec2(mudFlow - 0.5, sediment - 0.5) * 320.0;
  vec2 wpos = vWorld.xz + dwarp;
  float streak = fbm(vec2(dot(wpos, f) * 0.042 - uClock * 0.85, dot(wpos, fc) * 0.30));
  float streakK = smoothstep(0.34, 0.76, streak) * (0.18 + 0.82 * vFront) * uStreakK;
  body += body * (1.00 * streakK) + vec3(0.055, 0.046, 0.033) * streakK;
  /* 流头湿趾：最前沿压暗一道，读成「推土机铲刀」的湿泥边 —— 泥石流推进时
     最靠前的永远是最湿、最暗的那一条，后面才是翻起来的白沫。 */
  body *= 1.0 - 0.34 * smoothstep(0.45, 1.0, vFront);
  /* 立面阴影（2026-11-15）：墙脚（vFront 0.20~0.55）压暗、墙顶白冠提亮，
     一暗一亮画面才「立」得起来 —— 只给一个亮的包络时，水墙读起来仍是平面。 */
  float face = smoothstep(0.20, 0.55, vFront) * (1.0 - smoothstep(0.62, 0.95, vFront));
  body *= 1.0 - 0.22 * face;
  // 天空反射：泥浆从 2% 提到 7% —— 哪怕浑浊，湿面也总有掠射角的天空反光，
  // 这是「一眼认出是水」最便宜的线索，且只在边缘掠射角生效，不会洗白水体。
  vec3 col = body * diff + uSky * fres * mix(0.10, 0.07, uMuddy)
             + vec3(1.0, 0.94, 0.80) * spec * 0.60;

  // --- 湍流：噪声主导，不再用顺流向正弦 ---
  // sin(dot(world.xz, f)*0.30) 的周期约 21 m，在 600 m 视距下正好是屏幕上
  // 约 30 px 一道的等间距横纹，截图里把水面刷成「搓衣板」。改成同一份 fbm
  // 噪声做调制，条纹被打散成浑浊泥流的斑驳质感；粗糙度仍决定起伏强弱。
  float turb = (fn - 0.5) * 2.0;
  col *= 0.96 + 0.055*turb*(0.35 + vRough);

  // --- 泡沫 / 浪花：只在窄前锋带、波峰破碎处与湿边出现 ---
  float crest = smoothstep(ETA_MAX*0.34, ETA_MAX*0.90, vEta);
  float edge  = 1.0 - smoothstep(0.0, 1.8, vH);
  // 湿边泡沫 0.20 → 0.34：水面本身只有几十米宽，远景里全靠这道水线交代
  // 「水铺到哪里」；只靠颜色填充，很容易被棕色底图吃掉。
  // 2026-11-15：vFront 不再乘 wet（见顶点着色器），前锋权重终于能在流头满值，
  // 这里再叠一项 vFront² 的「破碎冠」——流头顶上那一圈翻卷的白浪。
  // vFront² 的作用是把白沫压在最前沿十几米内，不会向前锋后方蔓延成白饼。
  float foamK = clamp(vFoam*0.78 + vFront*0.88 + crest*vFront*0.55 + edge*0.34
                      + vFront*vFront*0.92, 0.0, 1.0);
  /* 主槽翻涌白沫（2026-11-15）：泥石流最显眼的视觉特征是「中间一条沸腾的白水带」——
     高浓度颗粒在槽心剧烈掺混、破碎起泡。这里用淹没势做槽心掩膜、再乘一层大尺度
     噪声控制断续，只在主流带上加白沫，漫流边不加。这是给 1~2 km 视距看的对比度：
     泥色与两侧岩坡同色系，没有这条白带，整条沟道在水里也会「消失」。 */
  float coreMask = smoothstep(0.40, 0.85, vCore);   // vCore = depth.bin 归一化真实流深
  // 频率必须压在 0.012 量级（≈ 80 m 一团）：0.055（18 m）在 1 km 视距下会碎成
  // 一排「白芝麻」，看着像噪点而不是沸腾的泥浆。
  float churn = smoothstep(0.46, 0.78, fbm(vWorld.xz * 0.012 - f * uClock * 0.55));
  foamK = clamp(foamK + coreMask * churn * (0.26 + 0.22 * uMuddy), 0.0, 1.0);
  foamK *= 0.28 + 0.82*fn;
  // 泥流的泡沫不是纯白，而是夹着细颗粒的暖白（2026-11-15 再压一档：
  // 近景整片被白沫洗成「浅米色盐斑」是之前最像「干涸泥壳」的原因，
  // 沫色压暗、混入上限从 0.78 降到 0.66，让泥浆仍是主体、白沫只是点缀）
  vec3 foamCol = mix(vec3(0.58, 0.55, 0.48), vec3(0.95, 0.92, 0.85), fn);
  col = mix(col, foamCol, clamp(foamK, 0.0, 0.66));
  /* 前锋白冠（2026-11-15 v2）：真实泥石流最前沿是几乎纯白的翻卷泡沫，与中后段
     暗褐泥浆形成强反差 —— 这是「一眼看出有冲击力」最直接的来源。
     只取 vFront 0.62 以上（最前沿十几米），不会向后蔓延成白饼；强度乘 fn，
     冠面因此是断断续续的浪花而不是一条均匀的白边。 */
  float crown = smoothstep(0.62, 1.0, vFront) * (0.55 + 0.45 * fn);
  col = mix(col, vec3(0.95, 0.93, 0.87), crown * 0.60);
  /* 白沫拉丝（2026-11-15）：真实泥石流表面是一张「撕开又连上」的白色网 ——
     顺流向拉长的细丝，而不是均匀的白点。复用上面域扭曲后的 wpos，把沿流向的
     采样频率压到横向的 1/5（等价于沿流向拉长 5 倍），只在已有泡沫处显形，
     权重压在 0.35 以内，不会把泥浆洗白。 */
  float lace = smoothstep(0.52, 0.86, fbm(vec2(dot(wpos, f) * 0.016 - uClock * 1.6,
                                              dot(wpos, fc) * 0.075)));
  col = mix(col, vec3(0.90, 0.89, 0.84), lace * foamK * 0.35);
  // 湿边压暗形成水线，泡沫边缘的高光碎点模拟《后天》式溃坝浪花颗粒
  col *= 1.0 - 0.26 * edge;
  // 水线外侧补一道很淡的冷色反光（天空掠射的残影）：泥色与棕色山坡同色系，
  // 边界特别容易糊掉，这道亮边把「水铺到这里为止」交代清楚。
  // 只在最外圈（vH < 1.8 m）生效，不会把水体整体洗白。
  col += vec3(0.46, 0.52, 0.55) * pow(edge, 2.0) * 0.14;
  col += vec3(0.85) * smoothstep(0.78, 0.97, fn) * foamK * 0.20;

  float alpha = clamp(uAlpha * (0.76 + 0.24*ext) * smoothstep(0.0, 1.0, vH), 0.0, 1.0);
  // 近景泥浆不透明（Unity HDRP「Dirty river」降低 Absorption Distance）：
  // 高浓度悬浮液不该透出河床。与斜纹无关 —— 斜纹属于水面之外的山坡影像。
  alpha = mix(alpha, 1.0, uMuddy);
  gl_FragColor = vec4(col, alpha);
}
`;

/* ------------------------------ 图 7 淹没范围（贴地层） ------------------------------
   把「按论文图 7 勾出的淹没范围」直接贴到真实地形上：一层极淡的蓝色填充 +
   一圈屏幕空间等宽的亮边界线。它回答的是「灾害物质铺到哪里」，与动态水面
   是两件事：
     · 水面（WATER_FRAG）跟着到达时间逐帧推进，只画当下有水的地方；
     · 本层画整场推演的最终包络，时刻 t=0 就能看到终点范围，俯视观感与文献图一致。
   边界用 fwidth 求屏幕空间梯度，任何缩放/倾角下线宽都稳定；不用几何描边，
   省掉一套边界提取，也不会因为网格粗而在山脊上切角。 */
const EXTENT_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const EXTENT_FRAG = `
uniform sampler2D uMask;
uniform float uSpan;      // 纹理编码覆盖的距离跨度（纹素），与 buildMaskSdf 一致
uniform vec3  uRim;
uniform float uOpacity;
uniform float uFillA;     // 恒为 0（2026-11-14）：只留线框，不要填充色
varying vec2 vUv;

void main() {
  float m = texture2D(uMask, vUv).r;
  // 有符号距离场：>0 在范围内（单位＝纹素）。R 通道 0.5 即边界线本身，
  // 所以边界不再是「0/255 的台阶」，而是可以逐像素插值的等值线。
  float d = (m - 0.5) * uSpan;
  // 屏幕空间等宽：fwidth(d) 就是「一个像素跨过多少纹素」
  float w = max(fwidth(d) * 1.60, 0.02);
  float rim = 1.0 - smoothstep(0.0, w, abs(d));
  float inside = smoothstep(0.0, 1.2, d);
  // 原来按视距铺 4%~13% 的蓝色底膜，近景会把整条谷道糊成一片；
  // 现在 uFillA 恒 0，只剩 rim（暖米白线框）。
  float a = inside * uFillA + rim * 0.92;
  if (a < 0.006) discard;
  gl_FragColor = vec4(uRim, a * uOpacity);
}`;

/* ------------------------------ 粒子 ------------------------------ */
const PARTICLE_VERT = `
attribute float aAlpha;
attribute float aSize;
attribute vec3  aTint;
varying float vAlpha;
varying vec3  vTint;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * (420.0 / max(-mv.z, 1.0)), 1.0, 42.0);
  gl_Position = projectionMatrix * mv;
  vAlpha = aAlpha; vTint = aTint;
}
`;
const PARTICLE_FRAG = `
precision mediump float;
varying float vAlpha;
varying vec3  vTint;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = (1.0 - smoothstep(0.12, 0.5, d)) * vAlpha;
  gl_FragColor = vec4(vTint, a);
}
`;

/* ==========================================================================
   FloodSystem
   ========================================================================== */
export class FloodSystem {
  /**
   * opts: { scene, renderer, meta, field, channel, model, osm, projector,
   *         chanPts, chanS, chanAt, displayY, texSat, arrBuf, depBuf, exag }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.cenAtFn = opts.cenAt || null;   // 演进中轴线（居中），缺省时回退到 chanAt
    this.enabled = true;
    this.layers = { water: true, debris: true, spray: true };
    this.tField = 0;
    this.frontS = 0;
    this.scenarioDepth = 47.5;
    this.peak = 47.5 * this.exag;
    this.depthVisual = 1;
    this.clock = 0;
    this.lastTF = -1e9;
    this.pendingJump = true;
    this.rng = mulberry32(20260826);   // ① 的确定性 seed：每次刷新重现同一场演进
    this.group = null;
    this.diag = { steps: 0, resets: 0, activeParticles: 0 };
  }

  /* ---------- ① 由真实数据烘焙「淹没源」纹理 ---------- */
  bakeSource() {
    const W = SW, H = SH;
    const { meta, field, chanPts, displayY, arrBuf, depBuf } = this;
    const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z;
    const cx = sx / W, cz = sz / H;
    const arr = new Uint8Array(arrBuf), dep = new Uint8Array(depBuf);
    const nx = field.nx, ny = field.ny;

    /* 里程基准与速度台阶（2026-11-14）：
       ① 2026-11-13 把中轴上端 1610 m（谷底 → 坡顶）裁掉后，channel 的弧长从 0 重新起算，
          而 model.json / arrival.bin 仍是「谷底起算」的旧基准 —— channel.json 的
          sOffsetM 记的就是这 1610 m。剖面里程 = 沟道里程 + sOffsetM。
       ② 剖面 T 在 15 km 处是两段常速的插值台阶（详见 smoothFrontT 注释），
          这里把 T 平滑一档，并把它与原始 T 的差做成沿程修正 dTk，
          同时加到到达时间场上，免得「前锋标记平滑了、水面还在原地顿一下」。 */
    this.sOff = this.channel && this.channel.sOffsetM ? this.channel.sOffsetM : 0;
    const prof = this.model.profile || [];
    this.profS = prof.map(p => p[0]);
    this.profT0 = prof.map(p => p[4]);
    const cal = this.model.paperCalibration || {};
    const smT = FRONT_SMOOTH
      ? smoothFrontT(this.profS, this.profT0, cal.frontArrivalDistM, cal.frontArrivalSec, FRONT_BAND)
      : null;
    this.profT = smT ? Array.from(smT) : this.profT0.slice();
    this.profTMax = this.profT.length ? this.profT[this.profT.length - 1] : 390;
    // 场时间口径 → 论文口径的换算系数（470/505 = 0.9307，见 inverseT 注释①）
    this.tComp = this.profTMax > 1 ? T_FIELD / this.profTMax : 1;
    this.dTk = new Float32Array(chanPts.length);
    if (smT) {
      for (let k = 0; k < chanPts.length; k++) {
        const s = (this.chanS ? this.chanS[k] : 0) + this.sOff;
        const a = interpSeries(this.profS, this.profT0, s);
        this.dTk[k] = interpSeries(this.profS, this.profT, s) - a;
      }
    }

    // a) 语义粗糙度底图（⑥）：建筑轮廓内阻力高，陡坡次之，河床最低
    const bldMask = new Uint8Array(W * H);
    const P = this.projector;
    for (const feat of (this.osm.features || [])) {
      if (!feat.geometry || feat.geometry.type !== 'Polygon') continue;
      const ring = feat.geometry.coordinates[0];
      if (!ring || ring.length < 4) continue;
      const poly = ring.map(p => [P.x(p[0]), P.z(p[1])]);
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const q of poly) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minZ = Math.min(minZ, q[1]); maxZ = Math.max(maxZ, q[1]); }
      const i0 = clamp(Math.floor((minX + sx / 2) / cx), 0, W - 1);
      const i1 = clamp(Math.ceil((maxX + sx / 2) / cx), 0, W - 1);
      const j0 = clamp(Math.floor((minZ + sz / 2) / cz), 0, H - 1);
      const j1 = clamp(Math.ceil((maxZ + sz / 2) / cz), 0, H - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = -sx / 2 + (i + 0.5) * cx, z = -sz / 2 + (j + 0.5) * cz;
        if (inPoly(x, z, poly)) bldMask[j * W + i] = 1;
      }
    }

    // b) 最近沟道点（与 build_gyirong_field.py 同一套「最近断面 + 横向延迟」思路）
    const best = new Float32Array(W * H).fill(1e18);
    const bestK = new Int32Array(W * H).fill(-1);
    const R = 2900;
    for (let k = 0; k < chanPts.length; k++) {
      const p = chanPts[k];
      const ci = (p.x + sx / 2) / cx - 0.5, cj = (p.z + sz / 2) / cz - 0.5;
      const i0 = Math.max(0, Math.floor(ci - R / cx)), i1 = Math.min(W - 1, Math.ceil(ci + R / cx));
      const j0 = Math.max(0, Math.floor(cj - R / cz)), j1 = Math.min(H - 1, Math.ceil(cj + R / cz));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = -sx / 2 + (i + 0.5) * cx, z = -sz / 2 + (j + 0.5) * cz;
        const d2 = (x - p.x) ** 2 + (z - p.z) ** 2;
        const q = j * W + i;
        if (d2 < best[q]) { best[q] = d2; bestK[q] = k; }
      }
    }

    // c) 逐格合成：T 来自 arrival.bin；淹没势优先用预先烘焙的 shape.bin。
    //
    //    shape.bin（scripts/build_gyirong_flood_shape.py）是按论文图 7 形态生成的
    //    包络：源头谷口一片扇形漫开 → 收束进东林藏布峡谷的细长主流 → 口岸。
    //    横向宽度沿程变化（L(s) 半宽剖面）、沟心恒为满淹没势（连续蓝芯）、
    //    谷底一侧可漫开而贴壁一侧被地形闸门否决。它替代了下面那段运行时
    //    「相对沟床高差 / REF_RISE」的现算 —— 后者是各向同性环形衰减，
    //    各段宽度几乎相同，只会得到一条等宽窄带，和文献图对不上。
    //    shape.bin 缺失时仍回退到旧口径，页面不至于打不开。
    const shap = this.shapeBuf ? new Uint8Array(this.shapeBuf) : null;
    // 中轴到达时间序列（2026-11-12 修）：arrival.bin 在淹没包络之外填的是 u8 最大值
    // （79×6 = 474 ≈ T_FIELD），含义是「永远不会到」。而沟道中轴沿程有约 4%（11 处、
    // 合计 ~880 m）的点恰好落在包络外 —— 那里 T 永远到不了、水深恒为 0，表现就是：
    // 水带断开，跟拍的「可见水头」向上游找不到水而卡住甚至倒退
    // （实测 t=300→330 前锋走了 646 m，锚点只挪 4 m 还回退了）。
    // 先把中轴序列的「永不」值按前后有效值线性插值补上，再沿程单调化。
    const T_BAD = T_FIELD - 12;
    const nK = chanPts.length;
    const chanT = new Float32Array(nK);
    for (let k = 0; k < nK; k++) {
      const u = (chanPts[k].x + sx / 2) / sx, v = (chanPts[k].z + sz / 2) / sz;
      const tv = sampleU8(arr, nx, ny, u, v) * field.arrivalScale;
      // 分速台阶的沿程修正（见 smoothFrontT）：场与剖面同步平滑，避免「标记平滑、水面顿一下」
      chanT[k] = tv >= T_BAD ? NaN : tv + this.dTk[k];
    }
    for (let k = 0; k < nK; k++) {
      if (!Number.isNaN(chanT[k])) continue;
      let a = k - 1; while (a >= 0 && Number.isNaN(chanT[a])) a--;
      let b = k + 1; while (b < nK && Number.isNaN(chanT[b])) b++;
      const va = a >= 0 ? chanT[a] : (b < nK ? chanT[b] : 0);
      const vb = b < nK ? chanT[b] : va;
      chanT[k] = (a >= 0 && b < nK) ? va + (vb - va) * (k - a) / (b - a) : (a >= 0 ? va : vb);
    }
    for (let k = 1; k < nK; k++) chanT[k] = Math.max(chanT[k], chanT[k - 1]);
    const srcBytes = new Uint8Array(W * H * 4);
    this.srcT = new Float32Array(W * H);
    this.srcPot = new Float32Array(W * H);
    this.srcRough = new Float32Array(W * H);
    this.srcCore = new Float32Array(W * H);
    // 口岸下游外延（见 buildPortTails 注释）；?tail=0 关掉
    const tail = (typeof location !== 'undefined' &&
                  new URLSearchParams(location.search).get('tail') === '0')
      ? null : buildPortTails(this);
    this.portTail = tail;
    /* 外延水的起算时刻 = 口岸中轴的单调到达时间；spread 用「到演示末尾还剩多少」
       的预算（截到 72 s）。口岸本身约 451 s 到水，留给扇区铺开的时间不多，
       所以扇形几乎是口岸一到水就跟着铺出去 —— 这正是真实里水撞到坎脚的样子。 */
    const tailBase = chanT[nK - 1];
    const tailSpread = Math.max(6, Math.min(72, T_FIELD - 10 - tailBase));
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const q = j * W + i, p4 = q * 4;
      const u = (i + 0.5) / W, v = (j + 0.5) / H;
      let T = sampleU8(arr, nx, ny, u, v) * field.arrivalScale;
      const D = sampleU8(dep, nx, ny, u, v) * field.depthScale;
      const k = bestK[q];
      const x = -sx / 2 + (i + 0.5) * cx, z = -sz / 2 + (j + 0.5) * cz;
      const tp = tail ? tailProbe(tail, x, z, tailBase, tailSpread) : null;
      if (k < 0) { this.srcT[q] = T; srcBytes[p4] = clamp(T / T_SCALE, 0, 1) * 255; continue; }
      const dist = Math.sqrt(best[q]);
      // 包络外的格子：改为继承最近中轴点的到达时间（横向略晚），
      // 这样中轴走廊的水不会因为「一格在包络外」而永远不来。
      if (T >= T_BAD) {
        T = tp ? Math.max(tp.T, tailBase) : Math.min(chanT[k] + dist / 25, T_BAD + 40);
      } else T = Math.max(0, T + this.dTk[k]);
      const bedN = chanPts[k].y;
      const bed = displayY(x, z);
      const delta = Math.max(0, bed - bedN);
      let pot;
      if (shap) {
        pot = sampleU8(shap, nx, ny, u, v) / 255;
        // 中轴走廊兜底（2026-11-12）：shape.bin 是「图 7 包络连通域」，
        // 沟道中轴是「每切片最低点」—— 两套几何不重合，沿程实测有 11 处、
        // 合计约 880 m 的中轴点落在包络外（pot=0）。后果不只是水面断开：
        // 跟拍的「可见水头」向上游找不到水，锚点会卡住甚至往回退。
        // 这里给中轴 ±110 m 一条恒定的窄芯，保证水带连续、锚点单调推进。
        pot = Math.max(pot, (1 - smoothstep(45, 115, dist)) * 0.62);
      } else {
        // 旧口径（回退）：真实 DEM 相对沟床高差决定「水能爬多高」，
        // 横向距离决定「能漫多远」，低淹没势幂次抬升做视觉展宽。
        pot = Math.pow(Math.max(0, 1 - delta / REF_RISE), 0.8);
        pot *= 1 - smoothstep(1200, 4200, dist);
        pot = Math.max(pot, Math.min(D / 18, 1) * 0.90);
        pot = clamp(pot, 0, 1);
        pot = Math.pow(pot, POT_WIDEN_GAMMA);
      }
      const slopeK = smoothstep(4, 90, delta);
      // 口岸外延：只在地形不高于口岸床面 TAIL_RISE 的范围内补淹没势（别爬到山坡顶上）
      if (tp && bed - chanPts[nK - 1].y < TAIL_RISE) pot = Math.max(pot, tp.pot);
      const rough = clamp(0.20 + 0.34 * slopeK + 0.62 * bldMask[q] + 0.12 * (D / 18), 0, 1);
      const core = clamp(D / 18, 0, 1);

      this.srcT[q] = T; this.srcPot[q] = pot; this.srcRough[q] = rough; this.srcCore[q] = core;
      srcBytes[p4]     = clamp(T / T_SCALE, 0, 1) * 255;
      srcBytes[p4 + 1] = pot * 255;
      srcBytes[p4 + 2] = rough * 255;
      srcBytes[p4 + 3] = core * 255;
    }
    const tex = new THREE.DataTexture(srcBytes, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.sourceTex = tex;

    // c2) 图 7 范围遮罩纹理：直接用 shape.bin 原始 nx×ny（不经过 SW×SH 降采样），
    //     并把二值掩膜转成有符号距离场再上传。直接上传 0/255 的掩膜会让边界在
    //     近景变成 42 m 一格的大台阶；距离场的 0.5 等值线可以逐像素插值，
    //     任何缩放下都是一条平滑闭合线（离边界 >1 km 的格点饱和，不影响观感）。
    if (this.shapeBuf) {
      /* 外延那圈要一起写进「淹没范围」的掩膜，否则水面会漫出框线 ——
         sdf 的 0.5 等值线就是页面上那条描边。只在 50 m 栅格上补最近邻，
         181k 格全扫太慢，先按外延包围盒裁。 */
      let mb = new Uint8Array(this.shapeBuf);
      if (tail && tail.length) {
        let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
        for (const line of tail) for (const p of line) {
          bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x);
          bz0 = Math.min(bz0, p.z); bz1 = Math.max(bz1, p.z);
        }
        const pad = 500;   // 扇形短支半宽可到 380 m，包围盒要留够
        const mx = sx / nx, mz = sz / ny;
        const i0 = clamp(Math.floor((bx0 - pad + sx / 2) / mx), 0, nx - 1);
        const i1 = clamp(Math.ceil((bx1 + pad + sx / 2) / mx), 0, nx - 1);
        const j0 = clamp(Math.floor((bz0 - pad + sz / 2) / mz), 0, ny - 1);
        const j1 = clamp(Math.ceil((bz1 + pad + sz / 2) / mz), 0, ny - 1);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          if (mb[j * nx + i]) continue;
          const x = -sx / 2 + (i + 0.5) * mx, z = -sz / 2 + (j + 0.5) * mz;
          const tp = tailProbe(tail, x, z);
          if (tp && tp.pot > 0.10) mb[j * nx + i] = 255;
        }
      }
      const sdf = buildMaskSdf(mb, nx, ny);
      const mt = new THREE.DataTexture(sdf, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
      mt.minFilter = mt.magFilter = THREE.LinearFilter;
      mt.wrapS = mt.wrapT = THREE.ClampToEdgeWrapping;
      mt.generateMipmaps = false;
      mt.needsUpdate = true;
      this.maskTex = mt;
    }

    // d) CPU 侧流向场：到达时间梯度（低 T → 高 T），供碎冰 / 粒子使用
    this.flowX = new Float32Array(W * H);
    this.flowZ = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const q = j * W + i;
      const im = Math.max(0, i - 1), ip = Math.min(W - 1, i + 1);
      const jm = Math.max(0, j - 1), jp = Math.min(H - 1, j + 1);
      const tx = this.srcT[j * W + ip] - this.srcT[j * W + im];
      const tz = this.srcT[jp * W + i] - this.srcT[jm * W + i];
      const len = Math.hypot(tx, tz) || 1;
      this.flowX[q] = tx / len; this.flowZ[q] = tz / len;
    }

    // e) 到达时间 → 沟道弧长反查（前锋位置与粒子生成用）
    //    profT / profTMax / tComp 已在 bakeSource 开头算好（见「里程基准与速度台阶」）
  }

  /* ---------- ② GPU 状态纹理与计算场景 ---------- */
  buildCompute() {
    const mkRT = () => {
      const rt = new THREE.WebGLRenderTarget(SW, SH, {
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      });
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.rtA = mkRT(); this.rtB = mkRT();
    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.initMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: INIT_FRAG,
      uniforms: { uSource: { value: this.sourceTex }, uTField: { value: 0 } },
      depthTest: false, depthWrite: false,
    });
    this.stepMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: STEP_FRAG,
      uniforms: {
        uState: { value: null }, uSource: { value: this.sourceTex },
        uTexel: { value: new THREE.Vector2(1 / SW, 1 / SH) },
        uDt: { value: 1 / 60 }, uTField: { value: 0 },
        uPeak: { value: 0 }, uClock: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this.quadMesh = new THREE.Mesh(this.quadGeo, this.initMat);
    this.computeScene = new THREE.Scene();
    this.computeScene.add(this.quadMesh);
    this.resetState();
  }

  resetState() {
    if (!this.rtA) return;
    const r = this.renderer;
    this.initMat.uniforms.uTField.value = this.tField;
    this.quadMesh.material = this.initMat;
    const old = r.getRenderTarget();
    for (const rt of [this.rtA, this.rtB]) {
      r.setRenderTarget(rt); r.render(this.computeScene, this.quadCam);
    }
    r.setRenderTarget(old);
    this.frontRT = this.rtA; this.backRT = this.rtB;
    this.diag.resets++;
  }

  stepGPU(dtReal) {
    const r = this.renderer;
    const old = r.getRenderTarget();
    this.quadMesh.material = this.stepMat;
    for (let k = 0; k < SUBSTEPS; k++) {
      this.stepMat.uniforms.uState.value = this.frontRT.texture;
      this.stepMat.uniforms.uDt.value = Math.max(dtReal / SUBSTEPS, 1 / 240);
      this.stepMat.uniforms.uClock.value = this.clock + k * (dtReal / SUBSTEPS);
      r.setRenderTarget(this.backRT);
      r.render(this.computeScene, this.quadCam);
      const tmp = this.frontRT; this.frontRT = this.backRT; this.backRT = tmp;
      this.diag.steps++;
    }
    r.setRenderTarget(old);
    this.waterMat.uniforms.uState.value = this.frontRT.texture;
  }

  /* ---------- ③ 连续水面网格 ---------- */
  buildWater() {
    const { meta, displayY } = this;
    const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z;
    const pos = new Float32Array(MW * MH * 3), uv = new Float32Array(MW * MH * 2);
    for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
      const q = j * MW + i;
      const x = -sx / 2 + sx * i / (MW - 1), z = -sz / 2 + sz * j / (MH - 1);
      pos[q * 3] = x;
      pos[q * 3 + 1] = (this.terrainY || displayY)(x, z) + 14;
      pos[q * 3 + 2] = z;
      uv[q * 2] = i / (MW - 1); uv[q * 2 + 1] = j / (MH - 1);   // 行 0 = 北，与 DataTexture / RT 一致
    }
    const idx = new Uint32Array((MW - 1) * (MH - 1) * 6);
    let k = 0;
    for (let j = 0; j < MH - 1; j++) for (let i = 0; i < MW - 1; i++) {
      const a = j * MW + i, b = a + 1, c = a + MW + 1, d = a + MW;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = a; idx[k++] = d; idx[k++] = c;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();

    const sunDir = new THREE.Vector3(-15000, 23000, -10000).normalize();
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG,
      uniforms: {
        uSource: { value: this.sourceTex }, uState: { value: this.frontRT.texture },
        uSat: { value: this.texSat },
        // 真实水法线贴图（three.js r160 官方素材，本地 lib/water/，运行时不联网）。
        // 缺失时用影像纹理占位并由 uHasNormals=0 全量回退到程序化波纹。
        uNormal0: { value: this.texWaterN0 || this.texSat },
        uNormal1: { value: this.texWaterN1 || this.texSat },
        uHasNormals: { value: (this.texWaterN0 && this.texWaterN1) ? 1 : 0 },
        uNormalScale: { value: new THREE.Vector2(260, 146) },
        uNormalStrength: { value: 0.30 },
        uFlowSpeed: { value: 0.10 },
        // 按视距混合的「泥浆模式」：近景→1 高频法线与高光衰减、悬浮泥沙斑驳为主；
        // 远景→0 保留清水式波光，让 22 km 全景仍能辨识水面存在。
        uMuddy: { value: 0 },
        uSrcTexel: { value: new THREE.Vector2(1 / SW, 1 / SH) },
        uTField: { value: 0 }, uPeak: { value: 0 }, uClock: { value: 0 },
        uExagToMeters: { value: 1 / (this.exag * 1.0) },
        uAlpha: { value: 0.93 },
        // 前锋涌浪高度（场景单位）。26 ≈ 20 m 实际高度：在 1.3 km 的近景里
        // 约等于流头凸起 1.5 个像素高度差，配合白冠即可看出「一道墙在推」；
        // 22 km 全景里被视距夸张系数放大后仍不突兀。?surge= 可调，0 = 关闭。
        // 前锋涌浪高度（场景单位）。46 ≈ 35 m 实际高度，2026-11-15 提到 58：
        // 末段机位压到 1.25 km 后，水墙在画面里被放大 2.7 倍，这个高度才够「挡视线」。
        // ?surge= 可调，0 = 关闭。
        uSurge: { value: 58 },
        // 流速条纹强度。1 = 开（默认），0 = 关；?streak=0 可关掉做 A/B 验收。
        uStreakK: { value: 1 },
        uSun: { value: sunDir }, uSky: { value: new THREE.Color(0.62, 0.74, 0.86) },
      },
      transparent: true, depthWrite: true, depthTest: true,
      side: THREE.DoubleSide, extensions: { derivatives: true },
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    // ?surge=<场景单位> 调前锋涌浪高度，?surge=0 关闭（A/B 对比与截图验收用）
    if (typeof location !== 'undefined') {
      const qs = new URLSearchParams(location.search).get('surge');
      if (qs !== null && Number.isFinite(+qs)) {
        this.waterMat.uniforms.uSurge.value = clamp(+qs, 0, 90);
      }
      const qk = new URLSearchParams(location.search).get('streak');
      if (qk !== null && Number.isFinite(+qk)) {
        this.waterMat.uniforms.uStreakK.value = clamp(+qk, 0, 2);
      }
    }
    this.waterMesh = new THREE.Mesh(g, this.waterMat);
    this.waterMesh.name = 'anchor_flood_water';
    this.waterMesh.renderOrder = 3.2;
    this.waterMesh.frustumCulled = false;
    this.group.add(this.waterMesh);
  }

  /* ---------- ③b 图 7 淹没范围（贴地图层） ----------
     网格按 shape.bin 的原始 nx×ny 逐格建，顶点高程取 terrainTriY（与地形网格同一套
     三角形插值，不是独立再采一次），所以整层是「贴着地形网格」的一条壳，不会陷进
     坡里；再加 EXTENT_OFFSET 的竖向余量兜住山脊处的弦高差。
     与水面分开：水面按到达时间逐帧推进，本层画的是整场最终包络。 */
  buildExtent() {
    if (!this.maskTex) return;              // shape.bin 缺失时不建这一层
    const { meta } = this;
    const nx = this.field.nx, ny = this.field.ny;
    const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z;
    const hAt = this.terrainY || this.displayY;
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = j * nx + i;
      // 顶点落在纹素中心：与 DataTexture 的采样位置 1:1，边界不会被插值抹平
      const u = (i + 0.5) / nx, v = (j + 0.5) / ny;
      const x = -sx / 2 + sx * u, z = -sz / 2 + sz * v;
      pos[q * 3] = x;
      pos[q * 3 + 1] = hAt(x, z) + EXTENT_OFFSET;
      pos[q * 3 + 2] = z;
      uv[q * 2] = u; uv[q * 2 + 1] = v;
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let k = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = a; idx[k++] = d; idx[k++] = c;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();

    this.extentMat = new THREE.ShaderMaterial({
      vertexShader: EXTENT_VERT, fragmentShader: EXTENT_FRAG,
      uniforms: {
        uMask: { value: this.maskTex },
        uSpan: { value: EXTENT_SDF_SPAN },
        uRim: { value: new THREE.Color(0.96, 0.90, 0.78) },   // 暖米白 #F5E6C8（用户 2026-11-14）
        uOpacity: { value: 1.0 },
        uFillA:   { value: 0.0 },     // 只留线框，无填充
      },
      transparent: true, depthWrite: false, depthTest: true,
      side: THREE.FrontSide, extensions: { derivatives: true },
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.extentMesh = new THREE.Mesh(g, this.extentMat);
    this.extentMesh.name = 'anchor_flood_extent';
    this.extentMesh.renderOrder = 3.4;      // 压在水面之上，水面漫过时边界仍可读
    this.extentMesh.frustumCulled = false;
    this.group.add(this.extentMesh);
  }

  /* ---------- ④ 碎冰 / 冰碛物（① 的可编辑 Group + 刚体感运动） ---------- */
  buildDebris() {
    const G = makeSculpt({
      id: 'flood_debris', kind: 'debris_field', anchor: 'anchor_flood_debris',
      parts: [],
      meta: { role: 'ice_and_moraine_transport', instances: N_ICE + N_ROCK },
      detailInventory: [
        { id: '冰块翻滚', mappedTo: 'part_ice_instances', confidence: 0.82 },
        { id: '冰碛物碰撞', mappedTo: 'part_rock_instances', confidence: 0.80 },
      ],
      confidence: { front: 0.86, rear: 0.55, note: '块体尺度与数量为视觉合成，非实测' },
      seed: 20260826,
    });
    G.name = 'anchor_flood_debris_group';

    const iceGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    // 压低亮度与自发光、提高粗糙度：原先亮白蓝的低面数多面体像一把塑料块，
    // 在浑浊泥流里太跳。灰蓝 / 暗褐更接近被泥沙裹住的碎冰与冰碛物。
    const iceMat = new THREE.MeshStandardMaterial({
      color: 0xb4c3c8, roughness: 0.62, metalness: 0.02, flatShading: true,
      emissive: 0x0c1a22, emissiveIntensity: 0.08, side: THREE.DoubleSide,
    });
    iceMat.name = 'GY_flood_ice';
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x53473c, roughness: 0.98, metalness: 0.0, flatShading: true,
      side: THREE.DoubleSide,
    });
    rockMat.name = 'GY_flood_moraine';

    this.ice = new THREE.InstancedMesh(iceGeo, iceMat, N_ICE);
    this.rock = new THREE.InstancedMesh(rockGeo, rockMat, N_ROCK);
    this.ice.name = 'part_ice_instances'; this.rock.name = 'part_rock_instances';
    this.ice.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rock.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ice.frustumCulled = this.rock.frustumCulled = false;
    this.ice.renderOrder = this.rock.renderOrder = 3.4;
    G.add(this.ice, this.rock);

    const rn = this.rng;
    this.bodies = [];
    for (let n = 0; n < N_ICE + N_ROCK; n++) {
      const isIce = n < N_ICE;
      this.bodies.push({
        id: n, isIce, idx: isIce ? n : n - N_ICE,
        x: 0, y: 0, z: 0, vx: 0, vz: 0,
        r: isIce ? 4 + rn() * 9 : 3.5 + rn() * 7,   // 2026-11-15：原 7~23 m 太大，抢主体
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(rn() * 6, rn() * 6, rn() * 6)),
        av: new THREE.Vector3((rn() - 0.5) * 3, (rn() - 0.5) * 3, (rn() - 0.5) * 3),
        seed: rn(), active: false, grounded: 0,
      });
    }
    this._m4 = new THREE.Matrix4();
    this._v3 = new THREE.Vector3();
    this._dq = new THREE.Quaternion();
    this._eu = new THREE.Euler();
    this.group.add(G);
    this.debrisGroup = G;
    this.reseedDebris(true);
  }

  reseedDebris(all) {
    const rn = this.rng;
    for (const b of this.bodies) {
      if (!all && b.active) continue;
      // 沿已湿沟段随机撒布：大部分留在本体，少部分贴前锋，避免「凭空出现」
      const back = 150 + rn() * Math.min(9000, Math.max(600, (this.frontS || 0) * 0.7));
      const s = clamp((this.frontS || 0) - back, 0, this.channel.lengthM);
      const c = this.chanAt(s);
      const lat = (rn() - 0.5) * (260 + 420 * rn());
      const t = this.tangentAt(s);
      b.x = c.x - t.z * lat; b.z = c.z + t.x * lat;
      const w = this.waterY(b.x, b.z, this.tField);
      b.vx = 0; b.vz = 0;
      b.y = w.h > 1 ? w.y - b.r * 0.30 : c.y;
      b.active = true; b.show = w.h > 1; b.grounded = 0;
      b.q.setFromEuler(new THREE.Euler(rn() * 6, rn() * 6, rn() * 6));
    }
  }

  /* ---------- ⑤ 浪花 / 飞溅 / 扬尘 ---------- */
  buildParticles() {
    this.spray = makeCloud(N_SPRAY, true, 3.0);
    this.dust = makeCloud(N_DUST, false, 7.0);
    this.spray.points.name = 'anchor_flood_spray';
    this.dust.points.name = 'anchor_flood_dust';
    this.group.add(this.spray.points, this.dust.points);
    for (const c of [this.spray, this.dust]) {
      for (const p of c.parts) p.life = 0;   // 首帧统一由 update 生成
    }
    this.buildImpactRing();
  }

  /* ---------- 冲击事件（2026-11-15）----------
     到达口岸的那一刻给一次「砸上去」的反应：一圈加法混合的冲击波环 +
     一次性爆散的浪花与扬尘。纯观感合成（口径 C），不参与任何水文量。
     环用 RingGeometry 贴在水面高度上，半径按 0→780 场景单位扩张、透明度衰减，
     1.3 s 内结束；不是「受灾范围圈」（那是 app.js 里的 impactRing，别混）。 */
  buildImpactRing() {
    const g = new THREE.RingGeometry(0.90, 1.0, 96, 1);
    const m = new THREE.MeshBasicMaterial({
      color: 0xe8f1ff, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, fog: false,
    });
    this.impactWave = new THREE.Mesh(g, m);
    this.impactWave.name = 'anchor_flood_impact_wave';
    this.impactWave.rotation.x = -Math.PI / 2;
    this.impactWave.visible = false;
    this.impactWave.renderOrder = 3.6;
    this.impactWave.frustumCulled = false;
    this.group.add(this.impactWave);
  }

  triggerImpact() {
    if (!this.channel) return;
    const L = this.channel.lengthM;
    const c = (this.cenAtFn || this.chanAt)(L);
    this.impact = { age: 0, on: true, x: c.x, y: c.y, z: c.z };
    this.impactBurst = 240;                       // 一次性爆散粒子数
    if (this.impactWave) {
      const w = this.waterY(c.x, c.z, this.tField);
      this.impactWave.position.set(c.x, w.y + 8, c.z);
      this.impactWave.scale.setScalar(60);
      this.impactWave.material.opacity = 0.55;
      this.impactWave.visible = true;
    }
  }

  updateImpact(dt) {
    const im = this.impact;
    if (!im || !im.on) return;
    im.age += dt;
    const k = clamp(im.age / 1.3, 0, 1);
    if (this.impactWave) {
      this.impactWave.scale.setScalar(60 + 740 * Math.pow(k, 0.62));
      this.impactWave.material.opacity = 0.55 * Math.pow(1 - k, 1.7);
    }
    if (k >= 1) {
      im.on = false;
      if (this.impactWave) { this.impactWave.visible = false; this.impactWave.material.opacity = 0; }
    }
  }

  /* ---------- 组装 ---------- */
  build() {
    this.bakeSource();
    this.group = new THREE.Group();
    this.group.name = 'flood_system';
    this.scene.add(this.group);
    this.buildCompute();
    this.buildWater();
    this.buildExtent();
    this.buildDebris();
    this.buildParticles();
    this.setEnabled(true);
    this.applyVisibility();
    return this;
  }

  /* 时间轴跳转（拖进度条 / ±30 s / 点阶段 / 改情景）时由 app.js 显式标记，
     这样连续播放不会被误判成跳帧而把 GPU 波面与碎冰反复重置。 */
  markJump() { this.pendingJump = true; }

  /* ---------- 时间 / 情景 ---------- */
  setFrame(ratio, scenarioDepth, jump) {
    this.tField = clamp(ratio, 0, 1) * T_FIELD;
    this.scenarioDepth = scenarioDepth;
    // 口径 B：论文表 4 平均流深作为淹没水位包络；× 垂直夸张 × 视距放大（口径 C）
    this.updatePeak();
    this.frontS = this.inverseT(this.tField);
    this.waterMat.uniforms.uTField.value = this.tField;
    this.stepMat.uniforms.uTField.value = this.tField;
    const rewound = this.tField < this.lastTF - 0.5;
    if (jump || this.pendingJump || rewound) {
      this.resetState();
      this.reseedDebris(true);
      this.pendingJump = false;
    }
    this.lastTF = this.tField;
    this.applyVisibility();
  }
  updatePeak() {
    this.peak = (this.scenarioDepth || 47.5) * this.exag * this.depthVisual;
    this.waterMat.uniforms.uPeak.value = this.peak;
    this.stepMat.uniforms.uPeak.value = this.peak;
    this.waterMat.uniforms.uExagToMeters.value = 1 / (this.exag * this.depthVisual);
  }
  setViewDistance(camDist) {
    // 记下来给碎冰用：远景把块体整体缩小（它们在 3 km 外只剩几个像素，
    // 留着只会把水面打成麻点）。
    this.camDist = camDist;
    /* 视距 → 视觉参数。只改观感，KPI 与水文数值不动。
       1) 水深夸张：22 km 全景里几十米水位看不见，必须放大；但近景（<2 km）不需要，
          1.8 倍在这里等于 111 m 水深，会把整条沟谷糊成一块平板 —— 所以近景降到 ~0.5 倍。
       2) 法线贴图重复次数：260 次摊在 22 km 上约 85 m 一格，2 km 内看就是一片同心
          「年轮」；近景加密到 20 m 一格，才像水面细纹。
       两个参数都随距离连续变化，全景视图的口径完全不变。 */
    const dv = camDist >= 2600
      ? 1.8 + 1.45 * smoothstep(2600, 17000, camDist)
      : 0.5 + 1.3 * clamp((camDist - 600) / 2000, 0, 1);
    if (Math.abs(dv - this.depthVisual) > 0.02) { this.depthVisual = dv; this.updatePeak(); }
    const ns = 260 + 980 * (1 - smoothstep(900, 14000, camDist));
    const u = this.waterMat && this.waterMat.uniforms.uNormalScale;
    if (u && Math.abs(u.value.x - ns) > 8) u.value.set(ns, ns * 146 / 260);
    // 近景（<900 m）走泥浆材质，2600 m 外回到清水波光，中间连续过渡。
    const um = this.waterMat && this.waterMat.uniforms.uMuddy;
    if (um) um.value = 1 - smoothstep(900, 2600, camDist);
  }

  /* ---------- 前锋（与水面自身到达时间一致） ---------- */
  /* 返回的是**当前沟道弧长**。这里有两个基准差必须换算，否则前锋标记会跑到水面外面：
     ① 时间口径：场时间 tField 是「比例 1.0 = 470 s」的压缩口径（timeCompress
        0.9307 = 470/505，见 field.json → frontArrivalSrc），而剖面 T 是论文的
        0 / 180 / 505 s。直接拿 tField 查剖面等于把时间轴拉长 7.4%。
     ② 里程口径：剖面 / 场仍是 2026-11-13 裁剪前「谷底起算」的基准，与当前沟道差
        sOff = 1610 m（channel.json → sOffsetM）。
     两处都换算后，前锋才落在真实湿边：t=180 s 处 15 000 − 1 610 = 13 390 m，
     与场里实测的「速度台阶位置」（13.4 km）吻合；不换算时它在前 1.2 km 的干沟道上。 */
  inverseT(t) {
    const a = this.profT || [], s = this.profS || [];
    const L = this.channel.lengthM, so = this.sOff || 0;
    if (!a.length) return clamp(t / 390, 0, 1) * L;
    const tp = t / (this.tComp || 1);        // 场时间 → 论文口径
    let v;
    if (tp <= a[0]) v = s[0];
    else if (tp >= a[a.length - 1]) v = s[s.length - 1];
    else {
      let lo = 0, hi = a.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= tp) lo = m; else hi = m; }
      const k = (tp - a[lo]) / Math.max(a[hi] - a[lo], 1e-6);
      v = s[lo] + (s[hi] - s[lo]) * k;
    }
    return clamp(v - so, 0, L);
  }
  /* 比例 → 前锋球所在的沟道比例（0~1）。与 inverseT 同一口径，
     让「前锋球 / 跟拍机位 / 水面湿边」三者不再互相错位几公里。 */
  frontPathAt(ratio) {
    const L = this.channel.lengthM;
    return clamp(this.inverseT(clamp(ratio, 0, 1) * T_FIELD) / L, 0, 1);
  }
  tangentAt(s) {
    const L = this.channel.lengthM;
    const a = this.chanAt(clamp(s - 45, 0, L)), b = this.chanAt(clamp(s + 45, 0, L));
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d };
  }
  frontPoint() {
    // 2026-11-14：优先用「居中中轴线」—— 原沟道有 2% 的段落落在淹没包络之外，
    // 前锋符号与浪花锚点会挂在干坡上
    const f = this.cenAtFn || this.chanAt;
    const c = f(clamp(this.frontS || 0, 0, this.channel.lengthM));
    return c;
  }
  frontHint() {
    const c = this.frontPoint(), t = this.tangentAt(this.frontS || 0);
    return { x: c.x, y: c.y, z: c.z, tx: t.x, tz: t.z };
  }

  /* ---------- CPU 采样：与 GLSL 同源，保证碎冰 / 粒子贴着水面 ---------- */
  sampleSrc(x, z) {
    const sx = this.meta.sizeMeters.x, sz = this.meta.sizeMeters.z;
    const u = clamp((x + sx / 2) / sx, 0, 0.9999), v = clamp((z + sz / 2) / sz, 0, 0.9999);
    const fx = u * SW - 0.5, fy = v * SH - 0.5;
    const i0 = clamp(Math.floor(fx), 0, SW - 1), j0 = clamp(Math.floor(fy), 0, SH - 1);
    const i1 = Math.min(SW - 1, i0 + 1), j1 = Math.min(SH - 1, j0 + 1);
    const tx = clamp(fx - i0, 0, 1), ty = clamp(fy - j0, 0, 1);
    const a = j0 * SW + i0, b = j0 * SW + i1, c = j1 * SW + i0, d = j1 * SW + i1;
    const mix = (arr, w0, w1, w2, w3) => arr[a] * w0 + arr[b] * w1 + arr[c] * w2 + arr[d] * w3;
    const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty), w2 = (1 - tx) * ty, w3 = tx * ty;
    return {
      T: mix(this.srcT, w0, w1, w2, w3),
      pot: mix(this.srcPot, w0, w1, w2, w3),
      rough: mix(this.srcRough, w0, w1, w2, w3),
      fx: mix(this.flowX, w0, w1, w2, w3),
      fz: mix(this.flowZ, w0, w1, w2, w3),
    };
  }
  waterY(x, z, tField) {
    const s = this.sampleSrc(x, z);
    const h = Math.max(0, this.peak * s.pot * riseFn(tField - s.T));
    return { y: (this.terrainY || this.displayY)(x, z) + 14 + h, h, s };
  }

  /* ---------- 每帧推进 ---------- */
  update(dtReal, now) {
    if (!this.enabled) return;
    this.clock = now / 1000;
    // 低帧率（软件渲染可到 0.25 fps）下 dtReal 可达数秒，块体一帧会被平流几百米，
    // 高度却仍按移动前的水面采样 → 大量碎石悬在半空。与 GPU 子步同口径钳制。
    const dt = Math.min(dtReal, 0.05);
    if (this.layers.water) this.stepGPU(dt);
    this.waterMat.uniforms.uClock.value = this.clock;
    this.updateImpact(dt);                  // 冲击波环按真实帧推进，先于早退
    if (this.tField <= 1.0) return;         // 失稳前没有洪水，不生成碎冰与飞溅
    if (this.layers.debris) this.updateDebris(dt);
    if (this.layers.spray) this.updateParticles(dt);
  }

  updateDebris(dt) {
    const rn = this.rng, bodies = this.bodies;
    const L = this.channel.lengthM;
    const sx = this.meta.sizeMeters.x, sz = this.meta.sizeMeters.z;
    const flowSpeed = clamp(28 + this.scenarioDepth * 1.1, 24, 92);  // 场景单位/真实秒（视觉）
    const cells = new Map();
    const CELL = 150;
    const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

    for (const b of bodies) {
      let w = this.waterY(b.x, b.z, this.tField);
      const outOfRange = Math.abs(b.x) > sx / 2 || Math.abs(b.z) > sz / 2;
      if (!b.active || w.h < b.r * 0.22 || outOfRange) {
        // 干区 / 出界 → 沿「已淹没沟段」重新入场，且必须真的找到有水的位置。
        // 找不到就这一帧不画，绝不保留上一帧的高度挂在空中。
        let found = null;
        for (let k = 0; k < 8; k++) {
          const back = 60 + rn() * Math.min(2600, Math.max(300, (this.frontS || 0) * 0.55));
          const s = clamp((this.frontS || 0) - back, 0, this.channel.lengthM);
          const c = this.chanAt(s);
          const t = this.tangentAt(s);
          const lat = (rn() - 0.5) * 300;
          const x = c.x - t.z * lat, z = c.z + t.x * lat;
          const ww = this.waterY(x, z, this.tField);
          if (ww.h > Math.max(2.5, b.r * 0.35)) { found = { x, z, y: ww.y, t }; break; }
        }
        if (!found) { b.active = false; b.show = false; continue; }
        b.x = found.x; b.z = found.z;
        b.y = found.y - b.r * 0.30;
        b.vx = found.t.x * flowSpeed * 0.55; b.vz = found.t.z * flowSpeed * 0.55;
        b.q.setFromEuler(new THREE.Euler(rn() * 6, rn() * 6, rn() * 6));
        b.active = true; b.show = true; b.grounded = 0;
        w = this.waterY(b.x, b.z, this.tField);
      }
      const s = w.s;
      // 惯性：速度向流场松弛而不是瞬间赋值 → 有延迟、有被水推着走的感觉
      const turb = Math.sin(this.clock * 2.2 + b.seed * 19) * 0.28;
      const tvx = (s.fx + turb * -s.fz) * flowSpeed;
      const tvz = (s.fz + turb * s.fx) * flowSpeed;
      const lag = 1 - Math.exp(-dt / 0.42);
      b.vx += (tvx - b.vx) * lag;
      b.vz += (tvz - b.vz) * lag;
      // 浅水搁浅（干湿边界）：摩擦骤增、翻滚变慢
      const shallow = smoothstep(b.r * 0.3, b.r * 1.6, w.h);
      b.grounded = 1 - shallow;
      b.vx *= 1 - 0.75 * b.grounded * dt * 6;
      b.vz *= 1 - 0.75 * b.grounded * dt * 6;
      b.x += b.vx * dt; b.z += b.vz * dt;
      // 位置变了就必须按新位置重采水面：高山峡谷里横向几十米落差可达数百米，
      // 沿用移动前的 w.y 会把块体整个甩到半空中（实测曾出现 4 km 悬空）。
      const w2 = this.waterY(b.x, b.z, this.tField);
      if (w2.h < b.r * 0.22) { b.active = false; b.show = false; continue; }

      // 翻滚：角速度随流速 / 剪切 / 前锋湍流变化，碰撞再叠脉冲。
      // 2026-11-15：整体乘 0.45 —— 泥石流里的大块是被泥浆「裹着走」的，
      // 不是在空中疯狂翻跟头；之前的高速自转让每块石头都像独立的飞石。
      const spd = Math.hypot(b.vx, b.vz);
      const shear = clamp(spd / (flowSpeed + 1), 0, 2);
      const frontBoost = 1 + 2.4 * clamp(1 - Math.abs(this.tField - s.T) / 90, 0, 1);
      const targetAV = (0.7 + 2.6 * shear) * frontBoost * (1 - 0.8 * b.grounded) * 0.45;
      b.av.x += (targetAV * (0.6 + b.seed) - b.av.x) * Math.min(dt * 3, 1);
      b.av.y += (targetAV * (0.4 + rn() * 0.5) - b.av.y) * Math.min(dt * 3, 1);
      b.av.z += (targetAV * (0.5 + b.seed * 0.7) - b.av.z) * Math.min(dt * 3, 1);
      this._eu.set(b.av.x * dt, b.av.y * dt, b.av.z * dt);
      this._dq.setFromEuler(this._eu);
      b.q.multiply(this._dq).normalize();

      // 半沉：中心低于水面，只露出上半块，像被泥流裹挟而不是浮在空气里。
      // 2026-11-15 加深（冰 0.34 / 岩 0.52）：露出水面 1/3 左右才像「泥浆里翻上来的
      // 大块」，之前露出 70% 看着就是一堆搁浅的石头。
      // 再对高度做硬上限，防止 CPU 双线性 / GPU 三次采样在陡边界给出不同水深。
      const baseY = (this.terrainY || this.displayY)(b.x, b.z) + 14;
      const bob = Math.sin(this.clock * 3.1 + b.seed * 27) *
                  Math.min(w2.h * 0.06, b.r * 0.18);
      b.y = Math.min(w2.y - b.r * (b.isIce ? 0.34 : 0.52) + bob,
                     baseY + w2.h + b.r * 0.5);
      b.show = true;
      const kk = key(b.x, b.z);
      if (!cells.has(kk)) cells.set(kk, []);
      cells.get(kk).push(b);
      void L;
    }

    // 空间哈希碰撞：碎冰 / 冰碛物互相推开并交换角动量，不是穿模漂过
    let contacts = 0;
    for (const b of bodies) {
      if (!b.active) continue;
      const ci = Math.floor(b.x / CELL), cj = Math.floor(b.z / CELL);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const arr = cells.get(`${ci + di},${cj + dj}`);
        if (!arr) continue;
        for (const o of arr) {
          if (o.id <= b.id || !o.active) continue;   // 每对只处理一次
          const dx = o.x - b.x, dz = o.z - b.z;
          const rr = b.r + o.r;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr || d2 < 1e-6) continue;
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
          const push = (rr - d) * 0.5;
          b.x -= nx * push; b.z -= nz * push;
          o.x += nx * push; o.z += nz * push;
          const rel = (o.vx - b.vx) * nx + (o.vz - b.vz) * nz;
          if (rel < 0) {
            const imp = -rel * 0.48;
            b.vx -= nx * imp; b.vz -= nz * imp;
            o.vx += nx * imp; o.vz += nz * imp;
            b.av.x += nz * imp * 0.06; b.av.z -= nx * imp * 0.06;
            o.av.x -= nz * imp * 0.06; o.av.z += nx * imp * 0.06;
          }
          contacts++;
        }
      }
    }
    this.diag.contacts = contacts;

    // 写实例矩阵
    const m = this._m4, sc = new THREE.Vector3();
    let shown = 0, floating = 0;
    for (const b of bodies) {
      // 干区/出界的块体实例缩到 0，而不是留着旧高度在画面里飘
      const k = b.show && b.active ? 1 : 0;
      if (k) {
        // 碰撞解算在高度计算之后还会推一次 x/z，所以最终以「写矩阵时的位置」
        // 重算水面高度。这是最后一道保险：无论前面怎么平流、推挤、重置，
        // 块体中心永远贴着本地水面，不会留在半空。
        const wf = this.waterY(b.x, b.z, this.tField);
        b.y = wf.y - b.r * (b.isIce ? 0.34 : 0.52)
            + Math.sin(this.clock * 3.1 + b.seed * 27) *
              Math.min(wf.h * 0.06, b.r * 0.18);
        shown++;
        if (b.y - wf.y > b.r * 1.2) floating++;
      }
      // 压扁成扁平碎块：半沉后只露出薄薄一层，不像立着的球。
      // 2026-11-15 再压薄（0.48/0.62 → 0.38/0.50），并让远景整体缩小：
      // 3 km 外块体只剩几个像素，留着只会把水面打成麻点，反而不像流体。
      const far = 1 - 0.5 * smoothstep(2500, 8000, this.camDist || 0);
      sc.set(b.r * k * far, b.r * (b.isIce ? 0.38 : 0.50) * k * far,
             b.r * (b.isIce ? 1.00 : 0.88) * k * far);
      m.compose(this._v3.set(b.x, b.y, b.z), b.q, sc);
      (b.isIce ? this.ice : this.rock).setMatrixAt(b.idx, m);
    }
    this.ice.instanceMatrix.needsUpdate = true;
    this.rock.instanceMatrix.needsUpdate = true;
    this.diag.activeBodies = bodies.filter(b => b.active).length;
    this.diag.shownBodies = shown;
    this.diag.floatingBodies = floating;
  }

  updateParticles(dt) {
    const front = this.frontHint();
    const t = this.tangentAt(this.frontS || 0);
    const spawnCloud = (c, dust) => {
      const rn = this.rng;
      for (const p of c.parts) {
        if (p.life > 0) {
          p.age += dt;
          p.vy -= (dust ? 60 : 220) * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          const w = this.waterY(p.x, p.z, this.tField);
          // 落到水面或飘到干山坡上就立刻消亡，别在空气里留一层颗粒
          if (p.age >= p.life || p.y < w.y - 4 || w.h < 1.0) p.life = 0;
        }
        if (p.life <= 0) {
          // 只在水头「已经湿了」的位置生成：此前 900/900 个浪花、415/420 个扬尘
          // 都生成在干区，等于往山坡上抛一层白点褐点，是「碎石飘在空中」的主因之一。
          /* 2026-11-15 v2（用户「没有冲击感」）：浪花原来撒在 ±230 m 宽的带上，
             900 颗摊平后是一层薄雾，看不出「水在砸」。现在收窄到 ±85 m 的沟心
             （h 最大、也是白冠所在处），沿流向反而拉长到 ±210 m 跟住水头；
             初速与生成高度都提上去、寿命压短 —— 读起来是持续的喷溅幕而不是飘浮颗粒。
             扬尘仍保持宽域（尘本来就是弥散的），不动。 */
          let w = null;
          for (let k = 0; k < 8; k++) {
            const lat = (rn() - 0.5) * (dust ? 700 : 170);
            const along = (rn() - 0.5) * (dust ? 520 : 420);
            const x = front.x + t.x * along - t.z * lat;
            const z = front.z + t.z * along + t.x * lat;
            const ww = this.waterY(x, z, this.tField);
            if (ww.h > (dust ? 2.0 : 2.5)) { p.x = x; p.z = z; w = ww; break; }
          }
          if (!w) { p.life = 0; p.size = 0; continue; }
          p.y = w.y + 2 + rn() * 7;
          const up = dust ? 8 + rn() * 18 : 34 + rn() * 86;
          const push = dust ? 6 + rn() * 16 : 30 + rn() * 95;
          p.vx = t.x * push + (rn() - 0.5) * (dust ? 20 : 58);
          p.vz = t.z * push + (rn() - 0.5) * (dust ? 20 : 58);
          p.vy = up;
          p.life = dust ? 0.8 + rn() * 1.2 : 0.26 + rn() * 0.44;
          p.age = 0;
          p.size = dust ? 4 + rn() * 7 : 1.6 + rn() * 3.0;
        }
      }
    };
    spawnCloud(this.spray, false);
    spawnCloud(this.dust, true);
    /* 冲击爆散（2026-11-15）：到达口岸时一次性甩出一批高速浪花与扬尘。
       与上面「水头附近持续冒泡」是两件事：这里是有方向的爆发，速度高一倍、
       寿命短、径向散开，读起来才是「砸上去」。 */
    if (this.impactBurst > 0 && this.impact) {
      const rn = this.rng, im = this.impact;
      const throwOut = (c, cnt, dust) => {
        for (const p of c.parts) {
          if (cnt <= 0) break;
          if (p.life > 0) continue;
          const a = rn() * Math.PI * 2, rr = rn();
          p.x = im.x + Math.cos(a) * rr * 46;
          p.z = im.z + Math.sin(a) * rr * 46;
          p.y = im.y + 4 + rn() * 12;
          const sp = dust ? 26 + rn() * 58 : 55 + rn() * 125;
          p.vx = Math.cos(a) * sp;
          p.vz = Math.sin(a) * sp;
          p.vy = (dust ? 18 : 46) + rn() * (dust ? 42 : 72);
          p.life = dust ? 1.3 + rn() * 1.5 : 0.55 + rn() * 0.85;
          p.age = 0;
          p.size = dust ? 6 + rn() * 9 : 2.4 + rn() * 4.4;
          cnt--;
        }
      };
      throwOut(this.spray, 240, false);
      throwOut(this.dust, 120, true);
      this.impactBurst = 0;
    }
    let alive = 0;
    for (const c of [this.spray, this.dust]) {
      const pos = c.geom.attributes.position.array;
      const al = c.geom.attributes.aAlpha.array;
      const sz = c.geom.attributes.aSize.array;
      const ti = c.geom.attributes.aTint.array;
      for (let i = 0; i < c.n; i++) {
        const p = c.parts[i];
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        const k = p.life > 0 ? clamp(1 - p.age / p.life, 0, 1) : 0;
      al[i] = k * (c.dust ? 0.30 : 0.72);
      sz[i] = p.life > 0 ? (p.size || 3) : 0;
        if (p.life > 0) alive++;
        if (!p.tintSet) {
          const q = c.dust ? [0.66, 0.55, 0.40] : [0.88, 0.94, 0.98];
          ti[i * 3] = q[0]; ti[i * 3 + 1] = q[1]; ti[i * 3 + 2] = q[2];
          p.tintSet = true;
        }
      }
      c.geom.attributes.position.needsUpdate = true;
      c.geom.attributes.aAlpha.needsUpdate = true;
      c.geom.attributes.aSize.needsUpdate = true;
      c.geom.attributes.aTint.needsUpdate = true;
    }
    this.diag.activeParticles = alive;
  }

  /* ---------- 图层 / 开关 ---------- */
  applyVisibility() {
    if (!this.group) return;
    const on = this.enabled, wet = this.tField > 1.0;
    this.group.visible = on;
    if (this.waterMesh) this.waterMesh.visible = on && this.layers.water;
    // 范围层与时间无关：它画的是整场包络，t=0 就该看得见
    if (this.extentMesh) this.extentMesh.visible = on && this.layers.extent;
    if (this.debrisGroup) this.debrisGroup.visible = on && this.layers.debris && wet;
    if (this.spray) this.spray.points.visible = on && this.layers.spray && wet;
    if (this.dust) this.dust.points.visible = on && this.layers.spray && wet;
  }
  setEnabled(on) { this.enabled = on; this.applyVisibility(); }
  setLayers(L) {
    this.layers = { water: !!L.flood, debris: !!L.debris, spray: !!L.spray,
                    extent: L.extent === undefined ? true : !!L.extent };
    this.applyVisibility();
  }
  setAlpha(a) { if (this.waterMat) this.waterMat.uniforms.uAlpha.value = a; }

  /* CPU 侧按与 GLSL 完全相同的公式复算一遍，用于验收「到底有多少格点真的有水」。
     不是推算，是直接读烘焙后的淹没源纹理。 */
  probeHydrology() {
    const n = SW * SH;
    let wet = 0, sum = 0, max = 0, potN = 0, potSum = 0;
    for (let q = 0; q < n; q++) {
      const h = Math.max(0, this.peak * this.srcPot[q] *
                         riseFn(this.tField - this.srcT[q]));
      if (h > 0.5) wet++;
      sum += h; if (h > max) max = h;
      potSum += this.srcPot[q]; if (this.srcPot[q] > 0.02) potN++;
    }
    return {
      wetCells: wet, wetPct: +(100 * wet / n).toFixed(2),
      meanH: +(sum / n).toFixed(2), maxH: +max.toFixed(1),
      potCells: potN, potMean: +(potSum / n).toFixed(3),
    };
  }

  diagnose() {
    return {
      enabled: this.enabled, layers: { ...this.layers },
      extent: !!(this.extentMesh && this.extentMesh.visible),
      hydro: this.probeHydrology(),
      grid: `${SW}x${SH}`, waterMesh: `${MW}x${MH}`,
      substeps: SUBSTEPS, steps: this.diag.steps, resets: this.diag.resets,
      tField: +this.tField.toFixed(1), peak: +this.peak.toFixed(1),
      depthVisual: +this.depthVisual.toFixed(2),
      // 口径 C：横向视觉展宽系数。wetPct / potCells 均基于展宽后的场，
      // 只用于观察构图，不能当作实测淹没范围。
      visualWidenGamma: POT_WIDEN_GAMMA,
      muddy: this.waterMat ? +this.waterMat.uniforms.uMuddy.value.toFixed(2) : null,
      frontS: Math.round(this.frontS || 0),
      bodies: this.bodies ? this.bodies.length : 0,
      activeBodies: this.diag.activeBodies || 0,
      shownBodies: this.diag.shownBodies || 0,
      floatingBodies: this.diag.floatingBodies || 0,
      contacts: this.diag.contacts || 0,
      particles: N_SPRAY + N_DUST, activeParticles: this.diag.activeParticles || 0,
    };
  }
}

/* ------------------------------ 小工具 ------------------------------ */
/* 二值掩膜 → 有符号距离场（纹素为单位，内部为负）。
   两遍 chamfer（3-4 度量）求外距与外距：先求「到最近内部格」的距离给外部格点，
   再求「到最近外部格」的距离给内部格点，两者合成有符号距离。
   编码：u8 = 127.5 − sdf · 127.5/SPAN，于是 R=127.5 恰好落在边界上，
   GPU 端只需 (R−0.5)·SPAN 就能拿回以纹素计的距离。 */
function chamferTo(target, nx, ny, want) {
  const INF = 1e9, n = nx * ny;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = target[i] === want ? 0 : INF;
  const D = 1.4142136;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = j * nx + i; let v = d[q];
    if (i > 0) v = Math.min(v, d[q - 1] + 1);
    if (j > 0) {
      v = Math.min(v, d[q - nx] + 1);
      if (i > 0) v = Math.min(v, d[q - nx - 1] + D);
      if (i < nx - 1) v = Math.min(v, d[q - nx + 1] + D);
    }
    d[q] = v;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const q = j * nx + i; let v = d[q];
    if (i < nx - 1) v = Math.min(v, d[q + 1] + 1);
    if (j < ny - 1) {
      v = Math.min(v, d[q + nx] + 1);
      if (i < nx - 1) v = Math.min(v, d[q + nx + 1] + D);
      if (i > 0) v = Math.min(v, d[q + nx - 1] + D);
    }
    d[q] = v;
  }
  return d;
}

function buildMaskSdf(buf, nx, ny) {
  const n = nx * ny;
  const bin = new Uint8Array(n);
  const TH = EXTENT_THRESH * 255;
  for (let i = 0; i < n; i++) bin[i] = buf[i] > TH ? 1 : 0;
  const out = new Uint8Array(n);
  const dOut = chamferTo(bin, nx, ny, 1);   // 外部格点 → 最近内部格
  const dIn = chamferTo(bin, nx, ny, 0);    // 内部格点 → 最近外部格
  for (let i = 0; i < n; i++) {
    const s = bin[i] ? -dIn[i] : dOut[i];
    out[i] = clamp(Math.round(127.5 - s * 127.5 / EXTENT_SDF_SPAN), 0, 255);
  }
  return out;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function sampleU8(buf, nx, ny, u, v) {
  const fx = clamp(u * (nx - 1), 0, nx - 1), fy = clamp(v * (ny - 1), 0, ny - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1);
  const tx = fx - i0, ty = fy - j0;
  const a = buf[j0 * nx + i0], b = buf[j0 * nx + i1];
  const c = buf[j1 * nx + i0], d = buf[j1 * nx + i1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function makeCloud(n, dust, sizeHint) {
  const geom = new THREE.BufferGeometry();
  const parts = [];
  const pos = new Float32Array(n * 3), alpha = new Float32Array(n);
  const size = new Float32Array(n), tint = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    parts.push({ x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0, size: sizeHint, tintSet: false });
    size[i] = sizeHint;
  }
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geom.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geom.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geom.setDrawRange(0, n);
  const mat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: dust ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.renderOrder = 3.6;
  return { geom, mat, points, parts, n, dust, sizeHint };
}

export const FLOOD_CONSTANTS = { SW, SH, MW, MH, SUBSTEPS, T_FIELD, ETA_MAX, N_ICE, N_ROCK, N_SPRAY, N_DUST };
