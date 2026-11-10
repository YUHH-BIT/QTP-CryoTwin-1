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

import * as THREE from './lib/three.module.js';
import { makeSculpt } from './proc.js';

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
const N_ICE = 260, N_ROCK = 220;   // 碎冰 / 冰碛物实例数
const N_SPRAY = 900, N_DUST = 420; // 浪花飞溅 / 扬尘粒子数

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
uniform float uTField, uPeak, uClock, uExagToMeters;
varying vec3  vWorld;
varying vec2  vUv, vFlow;
varying float vH, vEta, vFoam, vFront, vRough, vCore;

void main() {
  vUv = uv;
  vec4 src = bicubic(uSource, uv, uSrcTexel);   // 亚网格：C1 连续的 T / 淹没势 / 粗糙度
  float T = src.r * T_SCALE;
  float dSim = uTField - T;
  float h = max(0.0, uPeak * src.g * riseFn(dSim));
  float wet = smoothstep(0.0, 1.1, h);

  // 流向由到达时间场梯度给出（真实场推导，不是手画箭头）
  float tx = tAt(uSource, uv + vec2(uSrcTexel.x, 0.0)) - tAt(uSource, uv - vec2(uSrcTexel.x, 0.0));
  float tz = tAt(uSource, uv + vec2(0.0, uSrcTexel.y)) - tAt(uSource, uv - vec2(0.0, uSrcTexel.y));
  vFlow = normalize(vec2(tx, tz) + vec2(1e-5, 0.0));

  vec4 st = texture2D(uState, uv);
  float eta  = (st.r - 0.5) * 2.0 * ETA_MAX;
  vH = h; vEta = eta; vFoam = st.b; vRough = src.b; vCore = src.a;
  vFront = (dSim > 0.0 && dSim < FRONT_W) ? (1.0 - smoothstep(0.0, FRONT_W, dSim)) * wet : 0.0;

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
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const WATER_FRAG = GLSL_COMMON + `
uniform sampler2D uSat;       // Esri 真实影像：浅水折射透出阶地 / 农田 / 道路
uniform sampler2D uNormal0, uNormal1;  // three.js r160 官方真实水法线贴图（双相位）
uniform vec2  uNormalScale;   // 贴图在世界范围内的重复次数（等比例，避免拉伸）
uniform float uHasNormals, uNormalStrength, uFlowSpeed, uMuddy;
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
  float p1 = dot(vWorld.xz, f)*0.055 - uClock*2.35 + warp;
  float p2 = dot(vWorld.xz, fc)*0.11 + uClock*1.40 + warp*0.7;
  float p3 = dot(vWorld.xz, f)*0.24 - uClock*3.60 + depthM*0.035 + warp*1.6;
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
  // 近景泥浆（uMuddy→1）：高频法线坡度衰减到 22%，泥浆以漫反射为主。
  // 2026-11-10：曾一度压到完全归零去"修斜纹"，但洋红像素量化证实
  // 斜纹属于山坡卫星影像（水面只占画布右下角约 3.8%），不是水面缺陷，
  // 故恢复为温和衰减，保留一点大尺度明暗起伏。
  slope *= 1.0 - 0.78 * uMuddy;
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
  float spec = (pow(ndh, 96.0)*0.62 + pow(ndh, 20.0)*0.11) *
               (0.35 + 0.65*fn) * (0.30 + 0.70*detail) * (1.0 - 0.85*uMuddy);
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
  vec3 shallow = vec3(0.46, 0.355, 0.235);   // 浑浊泥黄（浅水）
  vec3 deep    = vec3(0.185, 0.135, 0.095);  // 深泥褐（主槽）
  vec3 body = mix(shallow, deep, clamp(depthM/18.0, 0.0, 1.0));
  // 卫星底图只透少量并压暖。泥浆模式进一步压到近乎不透明
  // （Unity HDRP「Dirty river」：降低 Absorption Distance）。
  // 注意：画面右侧那片斜纹是**山坡的卫星影像**，不是透过水面来的
  // （洋红像素量化：水面只占画布右下角约 3.8%），改这里不会也不必消掉它。
  float waterMix = mix(0.72 + 0.28*ext, 0.94 + 0.06*ext, uMuddy);
  body = mix(ground * vec3(0.46, 0.42, 0.34), body, waterMix);
  // 悬浮泥沙（口径 C）：泥流颜色来自高浓度颗粒散射，不是清水表面吸收。
  // Unity HDRP「Dirty river」/ Vortex Suspension 同源做法。
  // 两层**各向同性** fbm 以不同速度沿流向滚动，靠时间产生流动感。
  // 曾用「沿流向低频 × 横向高频」的 fbm 做拉长流纹，那本质是一组平行条带，
  // 会把条纹换个方向请回来；各向同性才不会织出方向性纹理。
  float sediment = fbm(vWorld.xz * 0.035 + f * uClock * 0.40);
  float mudFlow = 0.60 * fbm(vWorld.xz * 0.012 + f * uClock * 0.85)
                + 0.40 * fbm(vWorld.xz * 0.026 - f * uClock * 0.55 + 11.7);
  body *= 1.0 - uMuddy * (0.20 - 0.30 * sediment - 0.18 * mudFlow);
  vec3 col = body * diff + uSky * fres * mix(0.10, 0.02, uMuddy)
             + vec3(1.0, 0.94, 0.80) * spec * 0.55;

  // --- 湍流：噪声主导，不再用顺流向正弦 ---
  // sin(dot(world.xz, f)*0.30) 的周期约 21 m，在 600 m 视距下正好是屏幕上
  // 约 30 px 一道的等间距横纹，截图里把水面刷成「搓衣板」。改成同一份 fbm
  // 噪声做调制，条纹被打散成浑浊泥流的斑驳质感；粗糙度仍决定起伏强弱。
  float turb = (fn - 0.5) * 2.0;
  col *= 0.96 + 0.055*turb*(0.35 + vRough);

  // --- 泡沫 / 浪花：只在窄前锋带、波峰破碎处与湿边出现 ---
  float crest = smoothstep(ETA_MAX*0.34, ETA_MAX*0.90, vEta);
  float edge  = 1.0 - smoothstep(0.0, 1.8, vH);
  float foamK = clamp(vFoam*0.78 + vFront*0.88 + crest*vFront*0.55 + edge*0.20, 0.0, 1.0);
  foamK *= 0.28 + 0.82*fn;
  // 泥流的泡沫不是纯白，而是夹着细颗粒的暖白
  vec3 foamCol = mix(vec3(0.66, 0.63, 0.54), vec3(0.99, 0.96, 0.88), fn);
  col = mix(col, foamCol, clamp(foamK, 0.0, 0.78));
  // 湿边压暗形成水线，泡沫边缘的高光碎点模拟《后天》式溃坝浪花颗粒
  col *= 1.0 - 0.24 * edge;
  col += vec3(0.85) * smoothstep(0.78, 0.97, fn) * foamK * 0.20;

  float alpha = clamp(uAlpha * (0.76 + 0.24*ext) * smoothstep(0.0, 1.0, vH), 0.0, 1.0);
  // 近景泥浆不透明（Unity HDRP「Dirty river」降低 Absorption Distance）：
  // 高浓度悬浮液不该透出河床。与斜纹无关 —— 斜纹属于水面之外的山坡影像。
  alpha = mix(alpha, 1.0, uMuddy);
  gl_FragColor = vec4(col, alpha);
}
`;

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

    // c) 逐格合成：T 来自既有 arrival.bin（已含 6 m/s 横向漫流延迟）；
    //    淹没势由「真实 DEM 相对沟床高差」约束，低阶地/河漫滩才会被淹；
    //    原始 depth.bin 的沟道核心作为下限保留，不改动既有数据文件。
    const srcBytes = new Uint8Array(W * H * 4);
    this.srcT = new Float32Array(W * H);
    this.srcPot = new Float32Array(W * H);
    this.srcRough = new Float32Array(W * H);
    this.srcCore = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const q = j * W + i, p4 = q * 4;
      const u = (i + 0.5) / W, v = (j + 0.5) / H;
      const T = sampleU8(arr, nx, ny, u, v) * field.arrivalScale;
      const D = sampleU8(dep, nx, ny, u, v) * field.depthScale;
      const k = bestK[q];
      if (k < 0) { this.srcT[q] = T; srcBytes[p4] = clamp(T / T_SCALE, 0, 1) * 255; continue; }
      const dist = Math.sqrt(best[q]);
      const bedN = chanPts[k].y;
      const x = -sx / 2 + (i + 0.5) * cx, z = -sz / 2 + (j + 0.5) * cz;
      const bed = displayY(x, z);
      const delta = Math.max(0, bed - bedN);
      // 视觉包络：真实 DEM 相对沟床高差决定「水能爬多高」，横向距离决定「能漫多远」。
      // 指数 0.8 让阶地上的浅水不至于瞬间归零，形成连续的水边而不是一条硬线。
      let pot = Math.pow(Math.max(0, 1 - delta / REF_RISE), 0.8);
      pot *= 1 - smoothstep(1200, 4200, dist);
      pot = Math.max(pot, Math.min(D / 18, 1) * 0.90);
      pot = clamp(pot, 0, 1);
      // 展示口径 C：低淹没势区做幂次抬升 → 横向衰减长度放大约 1.6×，
      // 让 180 m 的窄湿区在跟拍画面里能占住合理宽度。写回 srcPot 与纹理 G 通道，
      // 使 GPU 顶点高度、GPU 波面、CPU 碎冰/粒子采样三者共用同一份场。
      // 这不是二维数值解，也不是实测淹没边界。
      pot = Math.pow(pot, POT_WIDEN_GAMMA);
      const slopeK = smoothstep(4, 90, delta);
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
    const prof = this.model.profile || [];
    this.profT = prof.map(p => p[4]);
    this.profS = prof.map(p => p[0]);
    this.profTMax = this.profT.length ? this.profT[this.profT.length - 1] : 390;
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
        uSun: { value: sunDir }, uSky: { value: new THREE.Color(0.62, 0.74, 0.86) },
      },
      transparent: true, depthWrite: true, depthTest: true,
      side: THREE.DoubleSide, extensions: { derivatives: true },
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.waterMesh = new THREE.Mesh(g, this.waterMat);
    this.waterMesh.name = 'anchor_flood_water';
    this.waterMesh.renderOrder = 3.2;
    this.waterMesh.frustumCulled = false;
    this.group.add(this.waterMesh);
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
        r: isIce ? 7 + rn() * 16 : 6 + rn() * 12,
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
      b.y = w.h > 1 ? w.y - b.r * 0.2 : c.y;
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
  }

  /* ---------- 组装 ---------- */
  build() {
    this.bakeSource();
    this.group = new THREE.Group();
    this.group.name = 'flood_system';
    this.scene.add(this.group);
    this.buildCompute();
    this.buildWater();
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
  inverseT(t) {
    const a = this.profT || [], s = this.profS || [];
    if (!a.length) return clamp(t / 390, 0, 1) * this.channel.lengthM;
    if (t <= a[0]) return s[0];
    if (t >= a[a.length - 1]) return s[s.length - 1];
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m; else hi = m; }
    const k = (t - a[lo]) / Math.max(a[hi] - a[lo], 1e-6);
    return s[lo] + (s[hi] - s[lo]) * k;
  }
  tangentAt(s) {
    const L = this.channel.lengthM;
    const a = this.chanAt(clamp(s - 45, 0, L)), b = this.chanAt(clamp(s + 45, 0, L));
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d };
  }
  frontPoint() {
    const c = this.chanAt(clamp(this.frontS || 0, 0, this.channel.lengthM));
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
        b.y = found.y - b.r * 0.2;
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

      // 翻滚：角速度随流速 / 剪切 / 前锋湍流变化，碰撞再叠脉冲
      const spd = Math.hypot(b.vx, b.vz);
      const shear = clamp(spd / (flowSpeed + 1), 0, 2);
      const frontBoost = 1 + 2.4 * clamp(1 - Math.abs(this.tField - s.T) / 90, 0, 1);
      const targetAV = (0.7 + 2.6 * shear) * frontBoost * (1 - 0.8 * b.grounded);
      b.av.x += (targetAV * (0.6 + b.seed) - b.av.x) * Math.min(dt * 3, 1);
      b.av.y += (targetAV * (0.4 + rn() * 0.5) - b.av.y) * Math.min(dt * 3, 1);
      b.av.z += (targetAV * (0.5 + b.seed * 0.7) - b.av.z) * Math.min(dt * 3, 1);
      this._eu.set(b.av.x * dt, b.av.y * dt, b.av.z * dt);
      this._dq.setFromEuler(this._eu);
      b.q.multiply(this._dq).normalize();

      // 半沉：中心略低于水面，只露出上半块，像被泥流裹挟而不是浮在空气里。
      // 再对高度做硬上限，防止 CPU 双线性 / GPU 三次采样在陡边界给出不同水深。
      const baseY = (this.terrainY || this.displayY)(b.x, b.z) + 14;
      const bob = Math.sin(this.clock * 3.1 + b.seed * 27) *
                  Math.min(w2.h * 0.06, b.r * 0.18);
      b.y = Math.min(w2.y - b.r * (b.isIce ? 0.12 : 0.28) + bob,
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
        b.y = wf.y - b.r * (b.isIce ? 0.12 : 0.28)
            + Math.sin(this.clock * 3.1 + b.seed * 27) *
              Math.min(wf.h * 0.06, b.r * 0.18);
        shown++;
        if (b.y - wf.y > b.r * 1.2) floating++;
      }
      // 压扁成扁平碎块：半沉后只露出薄薄一层，不像立着的球
      sc.set(b.r * k, b.r * (b.isIce ? 0.48 : 0.62) * k,
             b.r * (b.isIce ? 1.05 : 0.90) * k);
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
          let w = null;
          for (let k = 0; k < 8; k++) {
            const lat = (rn() - 0.5) * (dust ? 700 : 460);
            const along = (rn() - 0.5) * (dust ? 520 : 300);
            const x = front.x + t.x * along - t.z * lat;
            const z = front.z + t.z * along + t.x * lat;
            const ww = this.waterY(x, z, this.tField);
            if (ww.h > (dust ? 2.0 : 2.5)) { p.x = x; p.z = z; w = ww; break; }
          }
          if (!w) { p.life = 0; p.size = 0; continue; }
          p.y = w.y + 1 + rn() * 5;
          const up = dust ? 8 + rn() * 18 : 20 + rn() * 52;
          const push = dust ? 6 + rn() * 16 : 16 + rn() * 48;
          p.vx = t.x * push + (rn() - 0.5) * (dust ? 20 : 44);
          p.vz = t.z * push + (rn() - 0.5) * (dust ? 20 : 44);
          p.vy = up;
          p.life = dust ? 0.8 + rn() * 1.2 : 0.32 + rn() * 0.58;
          p.age = 0;
          p.size = dust ? 4 + rn() * 7 : 1.8 + rn() * 3.4;
        }
      }
    };
    spawnCloud(this.spray, false);
    spawnCloud(this.dust, true);
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
    if (this.debrisGroup) this.debrisGroup.visible = on && this.layers.debris && wet;
    if (this.spray) this.spray.points.visible = on && this.layers.spray && wet;
    if (this.dust) this.dust.points.visible = on && this.layers.spray && wet;
  }
  setEnabled(on) { this.enabled = on; this.applyVisibility(); }
  setLayers(L) {
    this.layers = { water: !!L.flood, debris: !!L.debris, spray: !!L.spray };
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
