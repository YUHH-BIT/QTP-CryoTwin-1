import * as THREE from './lib/three.module.js?v=20261111a';
import { OrbitControls } from './lib/OrbitControls.js?v=20261111a';
// 程序化建模骨架：spec → 可编辑 THREE.Group + 材质色板 + 着色器画岸边/立面
import { PALETTE, material, makeSculpt, assertAnchors, applyDamage,
         diagnose, attachFacade, attachBank, buildDistanceField } from './proc.js?v=20261111a';
// 洪水演进实景层：④ GPU 高度场 + 亚网格连续曲面 + 碎冰 / 飞溅粒子（④②⑤①⑥）
import { FloodSystem, FLOOD_CONSTANTS } from './flood.js?v=20261111a';

/* ==========================================================================
   吉隆「8·26」冰岩崩—泥石流灾害链 · 实景三维数字孪生推演（演示级）

   三维底座不再程序化示意，而是复用项目已有的真实地理数据：
     - DEM   : data/height.bin         1001×1001 Int16，AWS Terrarium / SRTM 派生
     - 影像  : data/texture.jpg        8192×4617，Esri World Imagery 离线切片
     - 晕渲  : data/texture_hillshade.jpg
     - 沟道  : data/channel.json       DEM 最小代价路径，22 km、5197 m → 1789 m
     - 场    : data/arrival.bin / depth.bin  512×289 到达时间 / 最大流深
     - 建筑  : data/osm_buildings.geojson    OSM 实测轮廓，按轮廓挤出
   论文数值（表 2 / 表 4 / §3.2 八阶段）只用于 KPI、时间轴与剧本。
   flood.js 的 GPU 高度场只解「表面波动与泡沫」（线性化浅水波方程），
   宏观淹没范围 / 到达时间来自上述真实场数据、水位包络来自论文表 4，
   不求解二维水动力、不产出任何流量 / 流速 / 到达时间的预测数字。
   论文：刘昌军等，水利学报，网络首发 2026-09-18，doi:10.3724/j.slxb.20260653
   ========================================================================== */

/* ------------------------------ 论文数据 ------------------------------ */

// 表 2：基准工况（1.8 亿 m³）关键控制断面模拟结果
const SECTIONS = [
  { name: '错坚河',   path: 0.18, q: 52.60, depth: 67.97, v: 42.68, vmax: 71.50 },
  { name: '色琼',     path: 0.72, q: 31.35, depth: 61.72, v: 34.39, vmax: 51.00 },
  { name: '吉隆口岸', path: 1.00, q: 18.83, depth: 47.50, v: 25.13, vmax: 33.19 },
];

// 表 4：不同物源规模下吉隆口岸模拟结果（到达时间换算为秒）
const SCENARIOS = [
  { v: 0.10, arrival: 33 * 60 + 45, depth: 15.02, vmax: 6.95,  q: 0.31 },
  { v: 0.20, arrival: 21 * 60 + 55, depth: 21.61, vmax: 11.85, q: 1.03 },
  { v: 0.40, arrival: 15 * 60 + 25, depth: 23.73, vmax: 15.85, q: 2.68 },
  { v: 0.60, arrival: 12 * 60 + 50, depth: 25.71, vmax: 20.04, q: 4.54 },
  { v: 0.90, arrival: 10 * 60 + 45, depth: 30.59, vmax: 24.76, q: 7.57 },
  { v: 1.30, arrival:  9 * 60 + 25, depth: 40.18, vmax: 29.11, q: 12.17 },
  { v: 1.60, arrival:  8 * 60 + 45, depth: 43.09, vmax: 31.76, q: 16.03 },
  { v: 1.80, arrival:  8 * 60 + 25, depth: 47.50, vmax: 33.19, q: 18.83 },
];
const BASE_TOTAL = SCENARIOS[SCENARIOS.length - 1].arrival; // 505 s

// 节点沿真实沟道按弧长比例定位（0 = 源区，1 = 吉隆口岸）
const NODES = [
  { id: 'source',     name: '冰岩崩源区',       sub: '错坚河上游 · 约 5150 m',        t: 0.00, kind: 'source' },
  { id: 'crater',     name: '撞击破碎区',       sub: '短距离骤降约 1400 m',           t: 0.08, kind: 'process' },
  { id: 'cuojian',    name: '错坚河断面',       sub: '平均坡降 30.56%',               t: 0.18, kind: 'section' },
  { id: 'confluence', name: '汇入口急弯',       sub: '错坚河 → 普热普强藏布',         t: 0.36, kind: 'process' },
  { id: 'barrier',    name: '普热普强堰塞湖',   sub: '坝高约 60 m · 库容 220 万 m³',  t: 0.60, kind: 'lake' },
  { id: 'seqiong',    name: '色琼断面',         sub: '10:55 前缘到达',                t: 0.72, kind: 'section' },
  { id: 'donglin',    name: '东林藏布',         sub: '下游坡降 6.08%',                t: 0.86, kind: 'process' },
  { id: 'port',       name: '吉隆口岸',         sub: '约 1800 m · 受冲击',            t: 1.00, kind: 'port' },
];

// 论文 §3.2 的 8 阶段动力演化链；r 为总历时比例（10:55 到色琼 ≈ 180/505 ≈ 0.356）
const STAGES = [
  { r: 0.000, name: '高位冰岩体失稳',           desc: '约 5150 m 高位冰岩体整体失稳，初始物源约 1.8 亿 m³，面积约 400 万 m²、厚约 45 m。', lvl: 'crit', node: 'source' },
  { r: 0.050, name: '高速坠落与撞击破碎',       desc: '数百米水平距离内骤降约 1400 m 至约 3750 m，强烈撞击形成冲击坑，冰岩体解体破碎。', lvl: 'crit', node: 'crater' },
  { r: 0.120, name: '冰水释放及冰川岩屑流形成', desc: '冰内、冰下储水释放，冰体破碎消融，液相比例上升，转化为高流动性冰川岩屑流。', lvl: 'warn', node: 'cuojian' },
  { r: 0.220, name: '沟道侵蚀裹挟和沿程增容',   desc: '沿错坚河高速下泄，持续铲刮沟床与岸坡，冰碛物、块石与浅层滑坡物质不断卷入。', lvl: 'warn', node: 'confluence' },
  { r: 0.300, name: '局部堵蓄与集中释放',       desc: '急弯与收缩段粗颗粒短时停滞堆积，形成普热普强堰塞水体；蓄积物质随后集中释放。', lvl: 'warn', node: 'barrier' },
  { r: 0.356, name: '多源水体补给及冰体消融',   desc: '10:55 前缘到达色琼控制断面；河道水、支沟汇水与融水持续加入，峰值流量约 31.35 万 m³/s。', lvl: 'crit', node: 'seqiong' },
  { r: 0.700, name: '高流动性碎屑流转泥石流',   desc: '东林藏布河谷展宽，水沙充分混合，粗颗粒沉积、细颗粒与水体继续向下游集中输出。', lvl: 'warn', node: 'donglin' },
  { r: 1.000, name: '冲击吉隆口岸',             desc: '约 11:00 到达吉隆口岸；洪峰约 18.83 万 m³/s，平均流深约 47.5 m，最大流速约 33.19 m/s。', lvl: 'crit', node: 'port' },
];

/* 图层按「看见什么」分三组，而不是按代码里的开关顺序摊平。
   `alias` 把同源的第二个状态位挂在同一个开关上：本地沙盘的实景洪水水面与
   旧「示意流深场」用的是同一份 arrival/depth 场（同时开会叠两层水），
   故合并成一项「洪水淹没场」；三维地球侧该位仍是泥流帧场开关。 */
const LAYERS = [
  { id: 'imagery',   label: '卫星影像',   on: true,  group: '底图与地形' },
  { id: 'contour',   label: '等高线',     on: false, group: '底图与地形' },

  { id: 'hazard',    label: '灾害体推进', on: true,  group: '灾害与水体' },
  { id: 'channel',   label: '演进沟道',   on: true,  group: '灾害与水体' },
  { id: 'flood',     label: '洪水淹没场', on: true,  group: '灾害与水体', alias: ['field'] },
  { id: 'debris',    label: '碎冰 / 冰碛物', on: true, group: '灾害与水体' },
  { id: 'spray',     label: '浪花 / 扬尘', on: true, group: '灾害与水体' },
  { id: 'lake',      label: '堰塞水体',   on: true,  group: '灾害与水体' },

  { id: 'buildings', label: 'OSM 建筑',   on: true,  group: '场景与标注' },
  { id: 'facade',    label: '立面窗格',   on: true,  group: '场景与标注' },
  { id: 'bank',      label: '岸边细节',   on: true,  group: '场景与标注' },
  { id: 'glacier',   label: '冰川源区',   on: true,  group: '场景与标注' },
  { id: 'nodes',     label: '节点标记',   on: true,  group: '场景与标注' },
  { id: 'labels',    label: '地名标签',   on: true,  group: '场景与标注' },
];

const SPEEDS = [1, 2, 4, 8];
const SIM_SECONDS_PER_REAL_SECOND = 14;

/* ------------------------------ 工具函数 ------------------------------ */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const $ = id => document.getElementById(id);

function fmtClock(sec) {
  const total = 10 * 3600 + 52 * 60 + Math.floor(sec);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}
function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}
function interpScenario(vol) {
  const v = clamp(vol, SCENARIOS[0].v, SCENARIOS[SCENARIOS.length - 1].v);
  let a = SCENARIOS[0], b = SCENARIOS[SCENARIOS.length - 1];
  for (let i = 0; i < SCENARIOS.length - 1; i++) {
    if (v >= SCENARIOS[i].v && v <= SCENARIOS[i + 1].v) {
      a = SCENARIOS[i]; b = SCENARIOS[i + 1]; break;
    }
  }
  const k = b.v === a.v ? 0 : (v - a.v) / (b.v - a.v);
  return {
    v,
    arrival: lerp(a.arrival, b.arrival, k),
    depth: lerp(a.depth, b.depth, k),
    vmax: lerp(a.vmax, b.vmax, k),
    q: lerp(a.q, b.q, k),
  };
}
// 前缘位置：t=0 源区；基准工况 180 s 到色琼(path .72)；总历时到口岸(path 1.0)
function frontPath(ratio) {
  const rSeq = 180 / BASE_TOTAL;
  const r = clamp(ratio, 0, 1);
  return r <= rSeq ? 0.72 * (r / rSeq) : 0.72 + 0.28 * ((r - rSeq) / (1 - rSeq));
}
function stageIndexAt(ratio) {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i++) if (ratio >= STAGES[i].r - 1e-6) idx = i;
  return idx;
}
function sectionAt(path) {
  if (path < 0.45) return null;
  if (path < 0.86) return SECTIONS[1];
  return SECTIONS[2];
}
// 所有面板数字的唯一来源，避免多处各自写死导致对不上账
function computeFrame(t, vol) {
  const s = interpScenario(vol);
  const total = s.arrival;
  const ratio = clamp(t / total, 0, 1);
  const path = frontPath(ratio);
  const lenM = channel ? channel.lengthM : 22000;
  let elev = 5150 - 3350 * path;
  if (channel && heights) {
    const c = chanAt(path * lenM);
    elev = trueHeight(c.lon, c.lat);           // 真实 DEM 采样，不再用示意剖面
  }
  return {
    s, total, ratio, path,
    clock: fmtClock(t),
    dist: lenM / 1000 * path,                  // km，沿 22 km 实测沟道
    elev,
    stageIdx: stageIndexAt(ratio),
    section: sectionAt(path),
    remain: Math.max(0, total - t),
  };
}

/* ------------------------------ 真实地理数据 ------------------------------ */
const DATA = './data/';
const EXAG = 1.3;                 // 垂直夸张，与项目既有三维页一致
const KZ = 110574;                // 每纬度米
const GRID = 321;                 // 显示网格：从 1001 原始 DEM 双线性降采样
const FIELD_GX = 256, FIELD_GY = 145;  // 流深场显示网格（纹理仍是 512×289 原精度）
const FIELD_T_SCALE = 390;        // 到场时间场按 390 s 口径生成，演示时间轴按总历时等比映射

let meta, heights, field, channel, model, osm, texSat, texHill, texWaterN0, texWaterN1;
let P, chanPts = [], chanS = [], dispH = null;

async function getJSON(name) {
  const r = await fetch(DATA + name, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name} 读取失败（HTTP ${r.status}）`);
  return r.json();
}
async function getBuf(name) {
  const r = await fetch(DATA + name, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name} 读取失败（HTTP ${r.status}）`);
  return r.arrayBuffer();
}
function loadTexture(name) {
  return new Promise((res, rej) => new THREE.TextureLoader().load(DATA + name, t => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    res(t);
  }, undefined, () => rej(new Error('贴图加载失败：' + name))));
}
/* three.js r160 官方水面法线贴图（Valve Portal 2 Flow 法用两张）。
   法线贴图是数据纹理，绝不能按 sRGB 解码；缺失时返回 null，水面自动回退到
   程序化波纹，保证页面不会因为少两个素材就整体崩掉。 */
function loadNormalTexture(name) {
  return new Promise(res => new THREE.TextureLoader().load('./lib/water/' + name, t => {
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    res(t);
  }, undefined, () => { console.warn('水法线贴图缺失，回退程序化波纹：' + name); res(null); }));
}
async function loadAssets() {
  const [m, hBuf, ch, md, fd, ob, ts, th, wn0, wn1] = await Promise.all([
    getJSON('meta.json'), getBuf('height.bin'),
    getJSON('channel.json'), getJSON('model.json'), getJSON('field.json'),
    getJSON('osm_buildings.geojson'),
    loadTexture('texture.jpg'), loadTexture('texture_hillshade.jpg'),
    loadNormalTexture('Water_1_M_Normal.jpg'),
    loadNormalTexture('Water_2_M_Normal.jpg'),
  ]);
  meta = m;
  heights = new Int16Array(hBuf);
  const n = meta.meshSize + 1;
  if (heights.length !== n * n) throw new Error('高度场长度不符：' + heights.length);
  channel = ch; model = md; field = fd; osm = ob;
  texSat = ts; texHill = th;
  texWaterN0 = wn0; texWaterN1 = wn1;
  P = makeProjector();
  buildDisplayHeight();
  buildChannelIndex();
}
function makeProjector() {
  const b = meta.bbox, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const kx = 111320 * Math.cos(cy * Math.PI / 180);
  return {
    cx, cy, kx,
    x: lon => (lon - cx) * kx,
    z: lat => -(lat - cy) * KZ,
    lon: x => cx + x / kx,
    lat: z => cy - z / KZ,
  };
}
// 双线性采样原始 1001 格 DEM，返回「相对 minHeight 的增量」
function demAt(lon, lat) {
  const b = meta.bbox, n = meta.meshSize, N = n + 1;
  const fx = (lon - b[0]) / (b[2] - b[0]) * n;
  const fy = (b[3] - lat) / (b[3] - b[1]) * n;
  const c = clamp(Math.floor(fx), 0, n - 1), r = clamp(Math.floor(fy), 0, n - 1);
  const tx = clamp(fx - c, 0, 1), ty = clamp(fy - r, 0, 1);
  const h00 = heights[r * N + c], h10 = heights[r * N + c + 1];
  const h01 = heights[(r + 1) * N + c], h11 = heights[(r + 1) * N + c + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}
const trueHeight = (lon, lat) => meta.minHeight + demAt(lon, lat);   // 绝对高程 m（KPI 用）
const sceneY = (lon, lat) => demAt(lon, lat) * EXAG;                  // 原始 1001 格 DEM 的 y
const xOf = lon => P.x(lon), zOf = lat => P.z(lat);

// 地形显示网格是 321 格降采样，陡谷里它比原始 DEM 谷底高出数百米。
// 沟道 / 灾害体 / 建筑等贴地要素必须采样「显示网格高度」才能与地形严格共面，
// 否则会被埋进山体（这也是高度图精度取舍里最容易踩的一坑）。
function buildDisplayHeight() {
  dispH = new Float32Array(GRID * GRID);
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const lon = meta.bbox[0] + (meta.bbox[2] - meta.bbox[0]) * c / (GRID - 1);
    const lat = meta.bbox[3] - (meta.bbox[3] - meta.bbox[1]) * r / (GRID - 1);
    dispH[r * GRID + c] = sceneY(lon, lat);
  }
}
function displayY(x, z) {
  const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z;
  const fx = (x + sx / 2) / sx * (GRID - 1);
  const fy = (z + sz / 2) / sz * (GRID - 1);
  const c = clamp(Math.floor(fx), 0, GRID - 2), r = clamp(Math.floor(fy), 0, GRID - 2);
  const tx = clamp(fx - c, 0, 1), ty = clamp(fy - r, 0, 1);
  const h00 = dispH[r * GRID + c], h10 = dispH[r * GRID + c + 1];
  const h01 = dispH[(r + 1) * GRID + c], h11 = dispH[(r + 1) * GRID + c + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}

/* 地形网格每个 quad 被切成 (a,cc,b) 与 (a,d,cc) 两个三角形，
   渲染出来是分片线性，不是双线性。水面网格若用 displayY 的双线性值，
   浅水区会与地形互相穿插，出现三角形网格状的 z-fighting「编织纹」。
   这里按同一条对角线做分片线性采样，保证两层严格共面。 */
function terrainTriY(x, z) {
  const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z;
  const fx = (x + sx / 2) / sx * (GRID - 1);
  const fy = (z + sz / 2) / sz * (GRID - 1);
  const c = clamp(Math.floor(fx), 0, GRID - 2), r = clamp(Math.floor(fy), 0, GRID - 2);
  const tx = clamp(fx - c, 0, 1), ty = clamp(fy - r, 0, 1);
  const h00 = dispH[r * GRID + c], h10 = dispH[r * GRID + c + 1];
  const h01 = dispH[(r + 1) * GRID + c], h11 = dispH[(r + 1) * GRID + c + 1];
  return ty <= tx ? h00 + tx * (h10 - h00) + ty * (h11 - h10)
                  : h00 + ty * (h01 - h00) + tx * (h11 - h01);
}

function buildChannelIndex() {
  chanPts = channel.points.map(p => ({
    lon: p[0], lat: p[1], x: xOf(p[0]), z: zOf(p[1]),
    y: displayY(xOf(p[0]), zOf(p[1])),
  }));
  chanS = channel.points.map(p => p[3]);
}
function chanAt(s) {
  const n = chanS.length;
  if (s <= chanS[0]) return { ...chanPts[0] };
  if (s >= chanS[n - 1]) return { ...chanPts[n - 1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (chanS[m] <= s) lo = m; else hi = m; }
  const k = (s - chanS[lo]) / Math.max(chanS[hi] - chanS[lo], 1e-6);
  const a = chanPts[lo], b = chanPts[hi];
  return {
    lon: lerp(a.lon, b.lon, k), lat: lerp(a.lat, b.lat, k),
    x: lerp(a.x, b.x, k), z: lerp(a.z, b.z, k), y: lerp(a.y, b.y, k),
  };
}

/* ------------------------------ 三维场景 ------------------------------ */
let renderer, scene, camera, controls;
let chartArrival = null, chartFlow = null;   // 情景卡片两张趋势图（ECharts）
let terrainMesh, terrainMat, contourMesh, skirtMesh;
let flowMesh, flowUniforms, channelLine, hazardMesh, hazardMat, hazardGlow, hazardGlowMat;
let glacierGroup, lakeMesh, impactRing, impactFill, frontMarker, nodeGroup;
let bankField = null;
let flood = null, fieldBuffers = null;   // 洪水演进实景层 + 供其复用的原始场缓冲
let cineCam = false, cineSnap = false, cineVecA = null, cineVecB = null;

// 着色器 uniform 全部提到外层：材质 needsUpdate 重新编译后引用仍然有效。
// 灾害带两层（本体 + 衬底）共用同一批对象，refresh 一次即可同步。
const bankUniforms = {
  uBank: { value: null }, uBankOn: { value: 1 }, uBankTime: { value: 0 },
};
const facadeUniforms = {
  uFacadeOn: { value: 1 }, uFacadeDamage: { value: 0 },
};
const hazardShared = {
  uFront: { value: 0 }, uTime: { value: 0 },
  uGain: { value: 0 }, uWidthBoost: { value: 0 },
  uAlpha: { value: 1 },          // 近景时淡出，别把口岸建筑与岸边糊住
};
let lakeKVal = 0, overlayDepth = false;
let nodeMarks = [], labelEls = [], pickables = [], buildings = [];
let bldFocus = null;             // OSM 建筑最密集的一簇，供「口岸聚落」近景镜头
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerOrigin = null;
let flight = null;
let autoFly = false;
let lastStageIdx = -1;
let avgFrame = 1 / 60, dpr = Math.min(window.devicePixelRatio || 1, 1.5);
const MAX_DPR = 1.5;

const state = {
  t: 0, playing: false, speed: 1, vol: 1.80,
  rotating: false,
  engine: 'three', autoCam: false,   // Cesium 视图默认 22 km 全景；点「自动运镜」才切近景跟拍
  // field 不再单独做成开关（本地已被 flood 取代），但 Cesium 侧仍用它控制泥流帧场
  layers: Object.assign({ field: true }, Object.fromEntries(LAYERS.map(l => [l.id, l.on]))),
};

/* 未开始推演时，画面顶部 HUD 位显示演示介绍（标题 + 副标题 + 演示级徽章），
   左面板阶段列表不高亮任何一项；用户一旦真正开始推演（播放 / 选阶段 / 拖时间轴
   / ?t= 定位），翻为 false，该位置切换为阶段播报并高亮当前阶段。 */
/* 仅内嵌模式启用「介绍态」：独立预览页顶部有自己的 56px 品牌栏，
   若 HUD 位再放一遍介绍标题会重复，故独立模式 introMode 恒为 false。 */
let introMode = new URLSearchParams(location.search).get('embedded') === '1';

/* -------------------- 第二视图：Cesium 三维地球 -------------------- */
// 时间映射口径：Cesium 页基准工况到达口岸为 500 s，本页表 4 基准为 505 s。
// 用「进度比例 × 505」驱动，基准工况两视图逐秒对齐；情景变化只改变演进快慢。
const CESIUM_TIME_SCALE = 505;
const CESIUM_LAYER_KEYS = ['imagery', 'channel', 'hazard', 'field',
                           'buildings', 'glacier', 'lake', 'labels'];
// 本地沙盘专有图层：切到三维地球时置灰。
// 「洪水淹没场」不在此列 —— 它已合并了三维地球侧控制泥流帧场的 field 位，
// 两个视图都有意义，所以切换后仍可勾选。
const THREE_ONLY_LAYERS = ['contour', 'nodes', 'facade', 'bank',
                           'debris', 'spray'];
const DIAG = new URLSearchParams(location.search).get('diag') === '1';
let cesiumFrame = null, cesiumRequested = false, cesiumReady = false;
let cesiumDiag = null, cesiumErr = '', lastCesiumT = -1;

const TERRAIN_CONTOUR_VERT = `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TERRAIN_CONTOUR_FRAG = `
precision highp float;
uniform float uExag;
uniform float uMinH;
varying vec3 vPos;
void main() {
  float H = vPos.y / uExag + uMinH;          // 还原成真实绝对高程（米）
  float yy = H / 200.0;                       // 每 200 m 一条首曲线
  float g = abs(fract(yy - 0.5) - 0.5) / max(fwidth(yy), 1e-4);
  float line = 1.0 - smoothstep(0.35, 1.30, g);
  float y5 = H / 1000.0;                      // 每 1000 m 一条计曲线
  float g5 = abs(fract(y5 - 0.5) - 0.5) / max(fwidth(y5), 1e-4);
  float major = 1.0 - smoothstep(0.35, 1.30, g5);
  float a = line * 0.10 + major * 0.17;
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.10, 0.19, 0.26, a);
}`;
const HAZARD_VERT = `
attribute float aT;
attribute float aSide;
attribute vec2 aNrm;
uniform float uWidthBoost;
varying float vT;
varying float vSide;
void main() {
  vT = aT; vSide = aSide;
  vec3 p = position;
  // 屏幕空间可读性自适应：相机拉远时沿横向法向把带子加宽，
  // 但顶点 y 仍按显示网格高度，且本体是态势叠加层（不做深度测试）。
  p.xz += aNrm * aSide * uWidthBoost;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const HAZARD_FRAG = `
precision highp float;
uniform float uFront;
uniform float uTime;
uniform float uGain;
uniform float uAlpha;
varying float vT;
varying float vSide;
void main() {
  if (vT > uFront) discard;
  // 相态渐变；在真实卫星影像上必须高对比，否则 22 km 全景里看不见
  // 上游压在白色雪山上、中游压在绿色山坡、下游压在褐色河谷，
  // 三段都得是高饱和色才能在真实影像上分辨出来
  vec3 ice  = vec3(0.16, 0.66, 0.95);
  vec3 rock = vec3(0.99, 0.62, 0.22);
  vec3 mud  = vec3(0.64, 0.24, 0.10);
  vec3 col = vT < 0.34 ? mix(ice, rock, vT / 0.34)
                       : mix(rock, mud, (vT - 0.34) / 0.66);
  float ripple = 0.5 + 0.5 * sin(vT * 210.0 - uTime * 8.0 + vSide * 4.0);
  col *= 0.90 + 0.10 * ripple;
  col = mix(col, col * 1.08, uGain);
  col *= 1.0 - 0.32 * smoothstep(0.62, 0.98, abs(vSide));  // 暗边，影像上更立体
  // 流向箭头（④ 的做法）：沿沟道推进的 V 形亮纹，只示意方向、不代表流速
  float ph = fract(vT * 52.0 - uTime * 0.85 + abs(vSide) * 0.16);
  float chevron = smoothstep(0.40, 0.49, ph) * (1.0 - smoothstep(0.49, 0.58, ph));
  float rim = smoothstep(0.78, 0.99, abs(vSide));
  col += vec3(0.32, 0.27, 0.18) * chevron * (1.0 - rim) * 0.45;
  // 两侧亮描边，让 22 km 全景下的细带子立得住
  col = mix(col, vec3(1.0, 0.94, 0.76), rim * 0.40);
  // 前锋脉冲亮带
  float head = 1.0 - smoothstep(0.0, 0.035, uFront - vT);
  col = mix(col, vec3(1.0, 0.98, 0.88), head * (0.40 + 0.25 * sin(uTime * 5.0)));
  gl_FragColor = vec4(col, 0.98 * uAlpha);
}`;
const FIELD_VERT = `
uniform sampler2D uArrival, uDepth;
uniform float uArrScale, uDepScale, uExag, uTime;
varying float vD;
varying vec2 vUv;
void main() {
  vUv = uv;
  float T = texture2D(uArrival, uv).r * 255.0 * uArrScale;
  float D = texture2D(uDepth, uv).r * 255.0 * uDepScale;
  float dt = uTime - T;
  vD = D * smoothstep(0.0, 22.0, dt);
  vec3 p = position;
  // 流深 18 m 在 22 km 全景里几乎不可见，按显示比例放大抬升（只影响视觉，不改数值）
  p.y += vD * uExag * 6.0 + (vD > 0.02 ? 42.0 : 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FIELD_FRAG = `
precision highp float;
uniform float uTime;
uniform float uAlpha;
varying float vD;
varying vec2 vUv;
void main() {
  if (vD < 0.02) discard;
  vec2 q = vec2(vUv.x * 5.0, vUv.y * 24.0);
  q.y -= uTime * 0.012;
  float n = 0.5 + 0.5 * sin(q.x * 14.0 + sin(q.y * 9.0) * 3.0);
  float t = clamp(vD / 12.0, 0.0, 1.0);
  vec3 shallow = vec3(0.78, 0.55, 0.30);
  vec3 deep    = vec3(0.42, 0.20, 0.09);
  vec3 mud = mix(shallow, deep, t);
  mud = mix(mud, vec3(0.98, 0.90, 0.76), smoothstep(0.76, 0.99, n) * 0.48);
  float a = clamp(0.52 + t * 0.42, 0.52, 0.94);
  gl_FragColor = vec4(mud, a * uAlpha);
}`;

// 由「显示网格数 + 顶点抬升」生成贴合真实 DEM 的网格几何
function terrainGeometry(gx, gy, lift) {
  const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z;
  const pos = new Float32Array(gx * gy * 3), uv = new Float32Array(gx * gy * 2);
  for (let r = 0; r < gy; r++) for (let c = 0; c < gx; c++) {
    const i = r * gx + c;
    const lon = meta.bbox[0] + (meta.bbox[2] - meta.bbox[0]) * c / (gx - 1);
    const lat = meta.bbox[3] - (meta.bbox[3] - meta.bbox[1]) * r / (gy - 1);
    pos[3 * i] = -sx / 2 + sx * c / (gx - 1);
    pos[3 * i + 1] = sceneY(lon, lat) + lift;
    pos[3 * i + 2] = -sz / 2 + sz * r / (gy - 1);
    uv[2 * i] = c / (gx - 1);
    uv[2 * i + 1] = 1 - r / (gy - 1);       // 图像第一行 = 北
  }
  const idx = new Uint32Array((gx - 1) * (gy - 1) * 6);
  let k = 0;
  for (let r = 0; r < gy - 1; r++) for (let c = 0; c < gx - 1; c++) {
    const a = r * gx + c, b = a + 1, cc = a + gx + 1, d = a + gx;
    idx[k++] = a; idx[k++] = cc; idx[k++] = b;
    idx[k++] = a; idx[k++] = d; idx[k++] = cc;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function initScene() {
  const canvas = $('scene');
  // 透明画布 + CSS 天空渐变：比纯色背景更像真实三维场景
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(46, canvas.clientWidth / canvas.clientHeight, 20, 300000);
  camera.position.set(-8200, 15000, 16500);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 2200, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 180;      // 原来 420 太远，贴不近建筑与碎冰
  controls.maxDistance = 72000;
  controls.maxPolarAngle = Math.PI * 0.492;
  // autoRotateSpeed 只在「update(deltaTime)」下才是真正的 秒/圈（2 → 30 s/圈）。
  // 不传 dt 时 r160 退回「每帧固定角」，低帧率(SwiftShader)会慢到像没转。
  // 取 1.0 ≈ 60 秒/圈，全景沙盘稳重不晃；dt 由 loop 每帧传入。
  controls.autoRotateSpeed = 1.0;
  // 地图式交互：屏幕空间平移 + 右键 / Shift+左键平移 + 滚轮按光标位置缩放。
  // 默认 screenSpacePanning=false 时平移发生在世界 XZ 平面，斜视角下几乎拖不动。
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN,
  };
  controls.update();
  // 用户手动操作一律优先于任何自动运镜（跟拍 / 飞行 / 自动推演 / 自动旋转）。
  controls.addEventListener('start', onUserTakeover);
  canvas.addEventListener('pointerdown', e => {
    onUserTakeover();
    // capture 阶段先改按键映射，OrbitControls 随后的 pointerdown 才会按平移处理
    if (e.shiftKey) controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  }, { capture: true });
  window.addEventListener('pointerup', () => {
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  });
  // 滚轮缩放自己实现（锚定光标），阻止 OrbitControls 自带的 dolly；
  // 触屏 pinch 仍走 OrbitControls 的 touch 路径，不受影响。
  canvas.addEventListener('wheel', onWheelZoom, { capture: true, passive: false });

  scene.add(new THREE.HemisphereLight(0xdcefff, 0x24261d, 1.05));
  const sun = new THREE.DirectionalLight(0xfff2dc, 1.65);
  sun.position.set(-15000, 23000, -10000);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9ec8ff, 0.38);
  fill.position.set(13000, 9000, 12000);
  scene.add(fill);

  window.addEventListener('resize', onResize);
  canvas.addEventListener('pointerdown', e => { pointerOrigin = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', onPick);
}

// 岸边细节：把「到真实沟道的距离」烤成一张程序化距离场，交给地形片元着色器。
// 不新增几何体、不下载贴图 —— 与学习材料 ②「用着色器画地形」同一路子。
function buildBankField() {
  bankField = buildDistanceField(chanPts, meta.sizeMeters.x, meta.sizeMeters.z,
                                 768, 432, 900);
  bankUniforms.uBank.value = bankField.texture;
}

function buildTerrain() {
  terrainMat = attachBank(new THREE.MeshStandardMaterial({
    map: texSat, roughness: 0.96, metalness: 0, side: THREE.DoubleSide,
    color: 0xffffff,
  }), bankUniforms);
  terrainMesh = new THREE.Mesh(terrainGeometry(GRID, GRID, 0), terrainMat);
  terrainMesh.name = 'anchor_terrain';
  scene.add(terrainMesh);

  // 等高线叠层必须与地形同一网格密度，否则 161 格会与 321 格地形互相穿插
  contourMesh = new THREE.Mesh(
    terrainGeometry(GRID, GRID, 16),
    new THREE.ShaderMaterial({
      vertexShader: TERRAIN_CONTOUR_VERT, fragmentShader: TERRAIN_CONTOUR_FRAG,
      uniforms: { uExag: { value: EXAG }, uMinH: { value: meta.minHeight } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })
  );
  contourMesh.name = 'anchor_contour';
  contourMesh.renderOrder = 1;
  scene.add(contourMesh);
}

// 四周裙边，避免整块真实地形「悬空」
function buildSkirt() {
  const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z, depth = 420;
  const n = 96;
  const pos = [], idx = [];
  let v = 0;
  const quad = (x1, z1, y1, x2, z2, y2) => {
    pos.push(x1, y1, z1, x1, y1 - depth, z1, x2, y2 - depth, z2, x2, y2, z2);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };
  for (let c = 0; c < n; c++) {
    const x1 = -sx / 2 + sx * c / n, x2 = -sx / 2 + sx * (c + 1) / n;
    quad(x1, sz / 2, displayY(x1, sz / 2), x2, sz / 2, displayY(x2, sz / 2));
    quad(x2, -sz / 2, displayY(x2, -sz / 2), x1, -sz / 2, displayY(x1, -sz / 2));
  }
  for (let r = 0; r < n; r++) {
    const z1 = -sz / 2 + sz * r / n, z2 = -sz / 2 + sz * (r + 1) / n;
    quad(-sx / 2, z1, displayY(-sx / 2, z1), -sx / 2, z2, displayY(-sx / 2, z2));
    quad(sx / 2, z2, displayY(sx / 2, z2), sx / 2, z1, displayY(sx / 2, z1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  skirtMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x22394b, side: THREE.DoubleSide }));
  skirtMesh.name = 'anchor_skirt';
  scene.add(skirtMesh);
}

// 到达时间 / 流深场：纹理保持 512×289 原精度，仅显示网格降采样（性能取舍）
async function buildFlowField() {
  const [arrBuf, depBuf] = await Promise.all([getBuf('arrival.bin'), getBuf('depth.bin')]);
  fieldBuffers = { arrBuf, depBuf };    // 洪水层烘焙淹没源时复用同一份原始数据
  const mk = buf => {
    const t = new THREE.DataTexture(new Uint8Array(buf), field.nx, field.ny,
      THREE.RedFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };
  const texArr = mk(arrBuf), texDep = mk(depBuf);

  const gx = FIELD_GX, gy = FIELD_GY;
  const sx = meta.sizeMeters.x, sz = meta.sizeMeters.z;
  const pos = new Float32Array(gx * gy * 3), uv = new Float32Array(gx * gy * 2);
  for (let r = 0; r < gy; r++) for (let c = 0; c < gx; c++) {
    const i = r * gx + c;
    const px = -sx / 2 + sx * c / (gx - 1), pz = -sz / 2 + sz * r / (gy - 1);
    pos[3 * i] = px;
    pos[3 * i + 1] = displayY(px, pz) + 14;
    pos[3 * i + 2] = pz;
    uv[2 * i] = c / (gx - 1);
    uv[2 * i + 1] = r / (gy - 1);           // 行 0 = 北，与 DataTexture 一致
  }
  const idx = new Uint32Array((gx - 1) * (gy - 1) * 6);
  let k = 0;
  for (let r = 0; r < gy - 1; r++) for (let c = 0; c < gx - 1; c++) {
    const a = r * gx + c, b = a + 1, cc = a + gx + 1, d = a + gx;
    idx[k++] = a; idx[k++] = cc; idx[k++] = b;
    idx[k++] = a; idx[k++] = d; idx[k++] = cc;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();

  flowUniforms = {
    uArrival: { value: texArr }, uDepth: { value: texDep },
    uTime: { value: 0 },
    uArrScale: { value: field.arrivalScale }, uDepScale: { value: field.depthScale },
    uExag: { value: EXAG }, uAlpha: hazardShared.uAlpha,
  };
  flowMesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: flowUniforms, vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  }));
  flowMesh.name = 'anchor_flow';
  flowMesh.renderOrder = 3;
  scene.add(flowMesh);
}

/* 洪水演进实景层：与既有态势叠加层并存，不改动任何既有资产。
   opts 里全部是本项目已有的真实数据 / 函数，flood.js 不自行编造地形或沟道。 */
function buildFlood() {
  flood = new FloodSystem({
    scene, renderer,
    meta, field, channel, model, osm, projector: P,
    chanPts, chanS, chanAt, displayY, terrainY: terrainTriY,
    texSat, texWaterN0, texWaterN1, exag: EXAG,
    arrBuf: fieldBuffers.arrBuf, depBuf: fieldBuffers.depBuf,
  }).build();
  const f = computeFrame(state.t, state.vol);
  flood.setLayers(state.layers);
  flood.setFrame(f.ratio, f.s.depth);
}

function buildChannelLine() {
  // WebGL 的 LineBasicMaterial 线宽固定 1px，22 km 全景等于看不见；
  // 用细管代替，半径 26 m 才是这个尺度上可辨的沟道
  const pts = chanPts.map(p => new THREE.Vector3(p.x, p.y + 34, p.z));
  const cv = new THREE.CatmullRomCurve3(pts);
  channelLine = new THREE.Mesh(
    new THREE.TubeGeometry(cv, Math.min(chanPts.length, 460), 75, 8, false),
    // 峡谷里山脊会挡住谷底，态势层不做深度测试，保证全段可辨
    new THREE.MeshBasicMaterial({
      color: 0x7dd3fc, transparent: true, opacity: 0.88, depthTest: false, depthWrite: false,
    })
  );
  channelLine.name = 'anchor_channel';
  channelLine.renderOrder = 1;
  scene.add(channelLine);

  frontMarker = new THREE.Group();
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(190, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffc16a, depthTest: false, depthWrite: false })
  );
  ball.renderOrder = 4;
  frontMarker.add(ball);
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(260, 380, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffd08a, transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.renderOrder = 4;
  frontMarker.add(halo);
  frontMarker.name = 'anchor_front';
  frontMarker.renderOrder = 4;
  scene.add(frontMarker);
}

// 灾害体：沿真实沟道生成贴地带，按论文时间线推进并做相态渐变
function makeHazardGeometry(widthScale, liftExtra) {
  const SEG = 340;
  // 真实沟道点密集且急弯多，用 chanAt(s+Δ) 差分求法向会让带子折断；
  // 用弧长参数化的 CatmullRom 切线才连续平滑（与项目既有三维页同一做法）
  const cv = new THREE.CatmullRomCurve3(
    chanPts.map(p => new THREE.Vector3(p.x, p.y, p.z)), false, 'catmullrom', 0.5
  );
  const pos = new Float32Array((SEG + 1) * 2 * 3);
  const ts = new Float32Array((SEG + 1) * 2), sides = new Float32Array((SEG + 1) * 2);
  const nrms = new Float32Array((SEG + 1) * 2 * 2);   // 横向法向，供顶点着色器动态加宽
  const idx = [];
  const p = new THREE.Vector3(), tan = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG;
    cv.getPointAt(u, p);
    cv.getTangentAt(u, tan);
    nrm.set(-tan.z, 0, tan.x).normalize();
    // 22 km 全景下 100 m 宽的带子只有几个像素，按谷宽量级放大到 190~790 m
    const w = (190 + 600 * smooth(u)) * widthScale;
    for (let sd = 0; sd < 2; sd++) {
      const side = sd === 0 ? -1 : 1;
      const x = p.x + nrm.x * w * side, z = p.z + nrm.z * w * side;
      const k = (i * 2 + sd) * 3;
      pos[k] = x;
      // 与显示网格共面后只需很小抬升，避免 z-fighting
      pos[k + 1] = displayY(x, z) + 52 + 18 * (1 - u) + liftExtra;
      pos[k + 2] = z;
      ts[i * 2 + sd] = u;
      sides[i * 2 + sd] = side;
      nrms[(i * 2 + sd) * 2] = nrm.x;
      nrms[(i * 2 + sd) * 2 + 1] = nrm.z;
    }
    if (i < SEG) {
      const a = i * 2, b = a + 1, cc = a + 2, d = a + 3;
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
  g.setAttribute('aNrm', new THREE.BufferAttribute(nrms, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function buildHazardStrip() {
  hazardMat = new THREE.ShaderMaterial({
    vertexShader: HAZARD_VERT, fragmentShader: HAZARD_FRAG,
    uniforms: hazardShared,
    // 态势叠加层：真实峡谷的山脊会完全挡住谷底，关掉深度测试才能看见演进
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });

  // 浅色衬底：真实影像有雪山、绿坡、褐谷三段，单靠相态色会被底图吃掉。
  // 两层共用同一批 uniform 对象（uFront / uTime / uWidthBoost），一次刷新同步。
  // 衬底改成「中间淡、外缘亮」的发光描边，比均匀一片白更不遮影像。
  hazardGlowMat = new THREE.ShaderMaterial({
    vertexShader: HAZARD_VERT,
    fragmentShader: `
precision highp float;
uniform float uFront;
uniform float uTime;
uniform float uAlpha;
varying float vT;
varying float vSide;
void main() {
  if (vT > uFront) discard;
  float e = smoothstep(0.42, 1.0, abs(vSide));
  float pulse = 0.82 + 0.18 * sin(uTime * 2.6 - vT * 18.0);
  // 衬底按底图明度自适应：上游压在白色雪山上用深蓝托底，
  // 下游压在绿坡/褐谷上用浅色托底，冰蓝与橙褐两段才都立得住。
  vec3 under = mix(vec3(0.10, 0.20, 0.31), vec3(1.0, 0.95, 0.82),
                   smoothstep(0.20, 0.52, vT));
  gl_FragColor = vec4(under, (0.07 + 0.23 * e) * pulse * uAlpha);
}`,
    uniforms: {
      uFront: hazardShared.uFront, uTime: hazardShared.uTime,
      uWidthBoost: hazardShared.uWidthBoost, uAlpha: hazardShared.uAlpha,
    },
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  hazardGlow = new THREE.Mesh(makeHazardGeometry(1.18, -8), hazardGlowMat);
  hazardGlow.renderOrder = 1.5;
  scene.add(hazardGlow);

  hazardMesh = new THREE.Mesh(makeHazardGeometry(1, 0), hazardMat);
  hazardMesh.name = 'anchor_hazard';
  hazardMesh.renderOrder = 2;
  scene.add(hazardMesh);
}

// OSM 实测建筑轮廓 → 真实坐标挤出（不是随机摆的示意盒子，也不是倾斜摄影）
// 建模走 proc.js 的 spec 工厂：一份 spec 描述「墙/屋顶/基座/轮廓线/锚点」，
// 材质全用命名约定从色板取，立面窗格由 GLSL 依侧面 UV 程序化生成。
function buildOSMBuildings() {
  const port = channel.port;
  const feats = (osm.features || []).filter(f => f.geometry && f.geometry.type === 'Polygon');
  const picked = [];
  for (const f of feats) {
    const ring = f.geometry.coordinates[0];
    if (!ring || ring.length < 4) continue;
    const lon = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    const d = Math.hypot((lon - port[0]) * P.kx, (lat - port[1]) * KZ);
    if (d > 3200) continue;                  // 只保留口岸核心区，避免整幅铺满
    picked.push({ f, ring, lon, lat, d });
    if (picked.length >= 220) break;
  }
  picked.sort((a, b) => a.d - b.d);

  // OSM 这批数据没有 height/levels，且分成了「口岸近旁 3 栋」与「2.7 km 外成片聚落」
  // 两簇。按 600 m 网格找最密的一簇，作为专门的立面近景镜头焦点。
  const cells = new Map();
  for (const it of picked) {
    const k = `${Math.round(xOf(it.lon) / 600)},${Math.round(zOf(it.lat) / 600)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(it);
  }
  const densest = [...cells.values()].sort((a, b) => b.length - a.length)[0] || picked;
  bldFocus = {
    x: densest.reduce((a, it) => a + xOf(it.lon), 0) / densest.length,
    z: densest.reduce((a, it) => a + zOf(it.lat), 0) / densest.length,
    count: densest.length,
  };

  let seq = 0;
  for (const it of picked) {
    try {
      const shape = new THREE.Shape();
      it.ring.forEach(([lo, la], i) => {
        const sx = xOf(lo), sz = -zOf(la);   // rotateX(-90°) 后 y→-z，故先取 -z
        if (i === 0) shape.moveTo(sx, sz); else shape.lineTo(sx, sz);
      });
      shape.closePath();
      const lv = parseFloat(it.f.properties.levels);
      const hh0 = parseFloat(it.f.properties.height);
      let hh = Number.isFinite(hh0) ? hh0 : (Number.isFinite(lv) ? lv * 3.2 : 8 + (it.d % 7));
      hh = clamp(hh, 5, 30);
      // OSM 该批数据无 height/levels 字段，8~15 m 是示意层高；
      // 做 2× 视觉放大才能让立面窗格在近景可辨（页面「说明」里已注明，不代表真实楼高）。
      hh = clamp(hh * 2.0, 10, 46);
      const baseY = displayY(xOf(it.lon), zOf(it.lat));

      // 主体：ExtrudeGeometry 的 group 0 = 顶/底盖、group 1 = 侧壁，
      // 用材质数组一次分出屋顶与墙面，不需要再建模。
      const geo = new THREE.ExtrudeGeometry(shape, { depth: hh, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);             // (x, y, z) → (x, z, -y)
      geo.translate(0, baseY, 0);

      // 基座薄台：同一轮廓再挤一次，颜色由色板区分（不做 scale，避免绝对坐标漂移）
      const baseGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.8, bevelEnabled: false });
      baseGeo.rotateX(-Math.PI / 2);
      baseGeo.translate(0, baseY - 1.4, 0);

      // 轮廓线：22 km 全景里建筑只有几个像素，勾边比贴图更能勾出聚落肌理
      const edgeGeo = new THREE.EdgesGeometry(geo, 24);

      const id = `osm_${String(seq++).padStart(3, '0')}`;
      const anchor = `anchor_${id}`;
      const g = makeSculpt({
        id, kind: 'building',
        parts: [
          { name: 'part_wall',  role: 'body', geometry: geo,
            material: [material('GY_roof'), material('GY_wall')] },
          { name: 'part_base',  role: 'base', geometry: baseGeo, material: material('GY_base') },
          { name: 'part_edge',  role: 'edge', geometry: edgeGeo,
            material: material('GY_edge'), line: true, renderOrder: 2 },
        ],
        anchor,
        meta: { baseY, hh, delay: it.d / 3200,
                levels: Number.isFinite(lv) ? lv : 0, anchorName: anchor },
      });
      scene.add(g);
      buildings.push(g);
    } catch (e) { /* 单个轮廓自交时跳过，不影响整体 */ }
  }
}

function buildGlacier() {
  const src = chanPts[0];
  // 与建筑同一套 spec 工厂：证明新增一类资产只要写一份 parts 描述。
  // 子块仍用相对坐标，整组缩放时才不会甩离源区。
  const seed = [[0, 0, 150], [190, -130, 110], [-170, 150, 125], [90, 210, 95], [-110, -180, 88]];
  const parts = seed.map(([dx, dz, r], i) => {
    const dy = displayY(src.x + dx, src.z + dz) - src.y;
    return {
      name: `part_ice_${i}`, role: 'body',
      geometry: new THREE.IcosahedronGeometry(r, 0), material: material('GY_ice'),
      position: [dx, dy + r * 0.55 + 30 + (i % 2) * 25, dz],
      scale: [1.25, 0.55, 1.0],
      rotation: [dx * 0.002, dz * 0.002, 0.2],
    };
  });
  glacierGroup = makeSculpt({
    id: 'glacier_source', kind: 'glacier', parts,
    anchor: 'anchor_glacier_socket', meta: { source: 'ice-rock avalanche source' },
  });
  glacierGroup.name = 'anchor_glacier';   // 保留既有锚点名，镜头/诊断按它取
  glacierGroup.position.set(src.x, src.y, src.z);
  scene.add(glacierGroup);
}

function buildLakeAndImpact() {
  const lp = chanAt(19900);
  const g = new THREE.CircleGeometry(760, 48);
  g.rotateX(-Math.PI / 2);
  lakeMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: 0x3d7fb8, transparent: true, opacity: 0, roughness: 0.2,
    metalness: 0.22, side: THREE.DoubleSide, depthWrite: false,
  }));
  lakeMesh.scale.set(1, 1, 0.36);
  lakeMesh.position.set(lp.x, lp.y + 22, lp.z);
  lakeMesh.name = 'anchor_lake';
  lakeMesh.renderOrder = 5;
  scene.add(lakeMesh);

  // 官方通报 0.7 km² 受灾范围：沿真实地形贴一圈
  const R = Math.sqrt(0.7e6 / Math.PI), pts = [];
  for (let i = 0; i <= 72; i++) {
    const a = i / 72 * Math.PI * 2;
    const x = xOf(channel.port[0]) + Math.cos(a) * R * 1.15;
    const z = zOf(channel.port[1]) + Math.sin(a) * R * 0.88;
    pts.push(new THREE.Vector3(x, displayY(x, z) + 26, z));
  }
  impactRing = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({
      color: 0xff5a4a, transparent: true, opacity: 0,
      depthTest: false, depthWrite: false,
    })
  );
  impactRing.name = 'anchor_impact';
  impactRing.renderOrder = 6;
  scene.add(impactRing);

  // 0.7 km² 受灾范围填充：只有边线的话 22 km 全景里几乎看不见
  const fg = new THREE.CircleGeometry(1, 64);
  fg.rotateX(-Math.PI / 2);
  impactFill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
    color: 0xff5a4a, transparent: true, opacity: 0,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  }));
  impactFill.scale.set(R * 1.15, 1, R * 0.88);
  impactFill.position.set(xOf(channel.port[0]),
    displayY(xOf(channel.port[0]), zOf(channel.port[1])) + 30, zOf(channel.port[1]));
  impactFill.renderOrder = 5;
  scene.add(impactFill);
}

function nodePos(n) {
  const c = chanAt(n.t * channel.lengthM);
  return new THREE.Vector3(c.x, c.y, c.z);
}
function buildNodes() {
  nodeGroup = new THREE.Group();
  nodeGroup.name = 'anchor_nodes';
  const labelHost = $('labels');
  NODES.forEach(n => {
    const p = nodePos(n);
    const color = n.kind === 'port' ? 0xd9602c : n.kind === 'lake' ? 0x2b7fd0 : 0xe8f2fb;
    const mark = new THREE.Mesh(
      new THREE.SphereGeometry(52, 14, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
    );
    mark.renderOrder = 7;
    mark.position.set(p.x, p.y + 95, p.z);
    mark.name = `anchor_${n.id}`;
    mark.userData.nodeId = n.id;
    nodeGroup.add(mark);
    nodeMarks.push(mark);
    pickables.push(mark);

    const el = document.createElement('div');
    el.className = 'node-label' + (n.kind === 'port' ? ' hot' : '');
    el.innerHTML = `<i></i>${n.name}<small>${n.sub}</small>`;
    labelHost.appendChild(el);
    labelEls.push(el);
  });
  scene.add(nodeGroup);

  // 锚点缺失直接抛错，不允许静默降级
  for (const key of ['terrain', 'contour', 'skirt', 'flow', 'channel', 'front',
                     'hazard', 'glacier', 'lake', 'impact', 'nodes', ...NODES.map(n => n.id)]) {
    if (!scene.getObjectByName(`anchor_${key}`)) throw new Error(`模型锚点缺失：anchor_${key}`);
  }
}

function onResize() {
  const c = $('scene');
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  // 面板宽度随断点变化，两张趋势图跟着重排
  if (chartArrival) chartArrival.resize();
  if (chartFlow) chartFlow.resize();
}
const isVisible = o => !o.visible ? false : (o.parent ? isVisible(o.parent) : true);
function onPick(e) {
  if (!pointerOrigin) return;
  const dx = e.clientX - pointerOrigin[0], dy = e.clientY - pointerOrigin[1];
  pointerOrigin = null;
  if (Math.hypot(dx, dy) > 6) return;        // 拖拽转视角不算点击
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    (e.clientX - rect.left) / rect.width * 2 - 1,
    -(e.clientY - rect.top) / rect.height * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  for (const hit of hits) {
    if (!isVisible(hit.object)) continue;    // Raycaster 不认 visible，需递归判断父级
    const idx = NODES.findIndex(n => n.id === hit.object.userData.nodeId);
    if (idx >= 0) { jumpToNode(idx); break; }
  }
}

/* ------------------------------ 镜头 ------------------------------ */
// 相机与地形的最小安全余量（场景单位，含 1.3× 垂直夸张）。
// 321 格显示网格对局部山脊会低估，三角形插值与双线性取较大值再叠加余量。
const CAM_GROUND_CLEAR = 60;    // 自由视角：只防「相机钻进地里」，不抢用户控制权
const CAM_AUTO_CLEAR = 140;     // 自动运镜：最小离地余量（过大会把镜头推到山顶、丢掉谷底洪水）
function groundAt(x, z) {
  return Math.max(terrainTriY(x, z), displayY(x, z));
}
/* 每帧最后一道保险：跟拍 / 飞行 / 自动旋转 / 自动推演都是沿直线插值，
   中途可能穿过山脊。这里按地形把相机抬到安全高度。
   用户自由视角只做最小防穿地约束，所以手动拉近看建筑不会被强行抬高。 */
function enforceCameraClearance() {
  const p = camera.position, t = controls.target;
  const auto = cineCam || !!flight || autoFly || state.rotating || rigStatic;
  let need = groundAt(p.x, p.z) + CAM_GROUND_CLEAR;
  if (auto) {
    need = groundAt(p.x, p.z) + CAM_AUTO_CLEAR;
    // 只检查相机身边极近的两点（防贴崖壁）；不沿整条视线抬升，
    // 否则峡谷侧翼山脊会把镜头推到山顶，谷底洪水反而看不见了。
    for (let i = 1; i <= 2; i++) {
      const u = i * 0.03;
      const qx = p.x + (t.x - p.x) * u, qz = p.z + (t.z - p.z) * u;
      need = Math.max(need, groundAt(qx, qz) + 60);
    }
  }
  if (p.y < need) p.y = need;
}
/* 用户一旦在画布上操作就立即接管视角：取消飞行、停自动推演/旋转、退出跟拍。
   OrbitControls 的 start 事件只在真实指针 / 滚轮输入时触发，程序 update 不会触发。 */
function onUserTakeover() {
  let changed = false;
  if (flight) { flight = null; changed = true; }
  if (autoFly) { autoFly = false; changed = true; }
  if (state.rotating) {
    state.rotating = false; controls.autoRotate = false;
    $('btn-rotate').classList.remove('active'); changed = true;
  }
  if (cineCam) { enableCine(false); changed = true; }
  if (state.autoCam) {
    state.autoCam = false;
    $('btn-autocam').classList.remove('active');
    postCesium({ type: 'setAutoCam', value: false });
    changed = true;
  }
  if (changed) pushLog('已接管视角：自动运镜与洪水跟拍已停止，鼠标操作不再被拉回。', 'info', state.t);
}
/* 地图式缩放：滚轮以「光标下的地面点」为锚点，而不是永远围绕固定 target。
   把相机与轨道中心同时相对锚点 P 按比例缩放：
     C' = P + (C-P)*s，T' = P + (T-P)*s
   则从 C' 看 P 的方向不变，P 在屏幕上不动；T' 同时向 P 靠拢，
   连续放大几次轨道中心自然移到光标处，于是可以放大任意局部。
   指到天空（射线无交点）时退化为普通围绕 target 缩放。 */
function onWheelZoom(e) {
  e.preventDefault();
  e.stopImmediatePropagation();   // 阻止 OrbitControls 自带 dolly，避免双重缩放
  onUserTakeover();
  if (state.engine !== 'three' || !terrainMesh) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set((e.clientX - rect.left) / rect.width * 2 - 1,
              -(e.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(terrainMesh, false);
  const P = hits.length ? hits[0].point.clone() : controls.target.clone();

  const C = camera.position.clone(), T = controls.target.clone();
  const d0 = Math.max(C.distanceTo(T), 1e-6);
  const s0 = Math.exp(clamp(e.deltaY, -300, 300) * 0.0011);
  const s = clamp(d0 * s0, controls.minDistance, controls.maxDistance) / d0;
  camera.position.copy(P.clone().add(C.sub(P).multiplyScalar(s)));
  controls.target.copy(P.clone().add(T.sub(P).multiplyScalar(s)));
}
function flyTo(targetVec, camVec, duration = 900) {
  autoFly = false;   // 任何主动飞行都退出播放跟拍，避免两套运镜抢相机
  // 终点先做地形约束，避免「飞到山里」；插值途中再由 enforceCameraClearance 兜底
  const to = camVec.clone();
  to.y = Math.max(to.y, groundAt(to.x, to.z) + CAM_AUTO_CLEAR);
  flight = {
    t0: performance.now(), dur: duration,
    fromPos: camera.position.clone(), toPos: to,
    fromTgt: controls.target.clone(), toTgt: targetVec.clone(),
  };
}
function flyToNode(idx) {
  const n = NODES[idx], p = nodePos(n);
  const target = new THREE.Vector3(p.x, p.y + 60, p.z);
  // 取景距离按节点类型给（口岸/断面看近，源区看远），不写死一组相机参数
  // 口岸看得更近：30 m 高的建筑在 2 km 视距下只有十几像素，立面层次出不来
  const d = n.kind === 'port' ? 1200 : n.kind === 'section' ? 2100 : 3100;
  const cam = target.clone().add(new THREE.Vector3(-d * 0.45, d * 0.72, d * 0.86));
  flyTo(target, cam, 900);
}

// 专门的「口岸聚落」近景：OSM 建筑大多不在沟道终点，点节点看的是灾害冲击，
// 想看立面层次得飞到建筑最密集的那一簇。
function flyToBuildings() {
  if (!bldFocus) return;
  const y = displayY(bldFocus.x, bldFocus.z);
  const target = new THREE.Vector3(bldFocus.x, y + 26, bldFocus.z);
  // 低俯角 + 近距离：从上方看只能看到屋顶，立面窗格要接近平视才看得见
  const d = 900;
  const cam = target.clone().add(new THREE.Vector3(-d * 0.50, d * 0.34, d * 0.86));
  flyTo(target, cam, 950);
}
function updateFlight(now) {
  if (!flight) return;
  const k = clamp((now - flight.t0) / flight.dur, 0, 1);
  const e = smooth(k);
  camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
  controls.target.lerpVectors(flight.fromTgt, flight.toTgt, e);
  if (k >= 1) flight = null;
}
/* 重置视角（原顶栏按钮已挪到画布右上工具条）：回到 22 km 全景。
   必须先把跟拍 / 自动运镜 / 自动旋转停掉——否则下一帧 updateDisasterFollow
   会把相机又拉回水头，用户看到的就是「点了没反应」。 */
function resetView() {
  if (state.engine === 'cesium') { resetCesiumView(); return; }
  if (cineCam) enableCine(false);
  autoFly = false;
  state.rotating = false;
  controls.autoRotate = false;
  $('btn-rotate').classList.remove('active');
  followSnap = false;
  applyLayers();
  markFloodJump();
  flyTo(new THREE.Vector3(0, 2200, 0), new THREE.Vector3(-8200, 15000, 16500), 950);
}

/* -------------------- 播放跟拍：镜头始终在灾害上方 -------------------- */
// 播放时跟着的是灾害体前锋（computeFrame.path → chanAt），与 frontMarker 同一位置；
// 原来每换阶段就 flyToNode 一次，8 次跳飞会让镜头脱离灾害并来回晃动。
let followSnap = false;
// 「沉浸式跟拍」= 洪水航拍 或 播放跟拍：两种模式都让镜头贴近灾害，
// 此时必须收起彩色态势符号，否则近景下巨大的前锋球/圆环会盖住真实水面与地形。
// ?rig= 定点构图验收：图层按沉浸模式收起，但不触发自动跟拍抢相机。
// 这样截图里看到的是跟拍模式的真实画面，不会混进全景的橙色态势带与节点标签。
let rigStatic = false, rigPending = null, rigPlaceInfo = null;
const immersiveCam = () => cineCam || autoFly || rigStatic;

/* 沿沟道弧长把机位放到「可见水头」后方 back 米、横向偏 lat、离水面 H、
   瞄准点再向下游前移 ahead 米。这是 follow / cine 两种跟拍共用的几何核心。
   两个关键口径（都是实测踩坑换来的）：
   ① 机位必须沿沟道走，不能沿切线直线后退 —— 弯道处直线会切出侧壁，
      az=0 时离地实测 −182 m（相机在地下）；
   ② 锚点是「画面里真有水的水头」，不是 frontS。frontS 是到达时间等值线，
      那里水深恰好 0，瞄它等于对着水前面的干坡。 */
function placeRigAt(back, lat, H, ahead) {
  const f = flood;
  if (!f || !f.chanAt) return null;
  const L = f.channel.lengthM;
  const cs = s => Math.max(0, Math.min(L, s));
  // ±300 m 基线求切线：沟道顶点间距中位数 63 m，±45 m 差分每个顶点跳一次方向
  const tangent = s => {
    const a = f.chanAt(cs(s - 300)), b = f.chanAt(cs(s + 300));
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d };
  };
  let s0 = cs(f.frontS || 0);
  for (let d = 0; d <= 1500; d += 50) {
    const s = cs(s0 - d), c = f.chanAt(s);
    if (f.waterY(c.x, c.z, f.tField).h > 2) { s0 = s; break; }
  }
  const sc = cs(s0 - back), c = f.chanAt(sc), t = tangent(sc);
  const px = c.x - t.z * lat, pz = c.z + t.x * lat;
  const base = Math.max(f.waterY(px, pz, f.tField).y, groundAt(px, pz));
  const py = base + H;
  const aS = cs(s0 + ahead), ac = f.chanAt(aS), aw = f.waterY(ac.x, ac.z, f.tField);
  camera.position.set(px, py, pz);
  controls.target.set(ac.x, aw.y + 20, ac.z);
  camera.lookAt(controls.target);
  camera.updateMatrixWorld(true);
  enforceCameraClearance();
  return { s0: Math.round(s0), pos: camera.position.toArray().map(v => +v.toFixed(1)),
           aim: controls.target.toArray().map(v => +v.toFixed(1)),
           clearance: +(py - groundAt(px, pz)).toFixed(1) };
}

/* -------------------- 全链条推演 / 洪水航拍：沿沟道 camera rig --------------------
   旧实现把机位写死成「水头后 1650 m、侧移 780 m、抬高 620 m」，实测俯角只有
   24~31°、水体仅占画高 18~28%，水带横向可到 NDC −2.73（大半条在框外）。
   新做法把景别交给几何解算而不是手填常数：
   · 机位沿沟道弧长布置 —— 沿切线直线后退在弯道会切出侧壁（实测离地 −182 m）；
   · 锚点取「画面里真有水的水头」，frontS 是到达时间等值线、那里水深恰好 0；
   · 切线用 ±300 m 基线 —— 沟道顶点间距中位数 63 m，±45 m 差分每个顶点跳一次；
   · 俯角由目标角度反解高度 —— 固定离水面高度在源区陡坡会变成仰视（实测 −4.6°）；
   · 机位远近由「湿点实测占画高」反馈 —— 固定 back 在口岸段会占满 99% 画面。 */
const RIG = {
  // 默认全链条推演跟拍 = 战术俯视机位（用户 2026-11-10 定：不再单独设按钮/模式）。
  // 用绝对高度 alt（相对瞄准点水面）而不是俯角反解 —— 俯角反解在 back 变大时
  // 会把相机抬到 2 km 以上，反而不是「谷上方」。实测俯角约 43°、离地约 645 m，
  // 沟谷走向与两侧地形关系清楚；水仍是一条窄带（真实湿区约 180 m 宽）。
  // 仍沿沟道弧长布机位，离地由 CAM_AUTO_CLEAR 兜底，共用可见水头/阻尼/用户接管。
  follow: { back: 1000, lat: -320, alt: 1050, pitch: 0, fill: 0.25,
            backMin: 800, backMax: 2000,
            sRate: 2.0, posRate: 2.2, tgtRate: 2.4, intro: 1.6, ahead: 600 },
  // 洪水航拍保留贴近水面的近景，作为与默认俯视并存的另一种观察方式。
  cine:   { back: 430, lat: -150, pitch: 26, fill: 0.55, backMin: 430, backMax: 1500,
            sRate: 2.8, posRate: 3.0, tgtRate: 3.2, intro: 1.1, ahead: 140 },
};
const rig = { mode: null, s: 0, back: 600, fill: 0, snap: true, introT: 1,
              cam0: new THREE.Vector3(), tgt0: new THREE.Vector3(),
              pos: new THREE.Vector3(), aim: new THREE.Vector3(), dbg: null };
const rigTmp = new THREE.Vector3();

function rigTangent(s, f, L) {
  const cs = v => Math.max(0, Math.min(L, v));
  const a = f.chanAt(cs(s - 300)), b = f.chanAt(cs(s + 300));
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}
// 可见水头：从 frontS 向上游找第一个真正有水的位置。
// 阈值用 h/peak 的相对值而不是绝对米数 —— 绝对阈值会随 setViewDistance 调
// depthVisual 而漂移（实测 t=300 机位因此向上游退了 500 m）；
// h/peak = pot×riseFn，与视觉放大系数无关。
function rigHead(f, L) {
  const cs = v => Math.max(0, Math.min(L, v));
  const pk = Math.max(f.peak || 1, 1e-3);
  const s0 = cs(f.frontS || 0);
  for (let d = 0; d <= 1500; d += 50) {
    const s = cs(s0 - d), c = f.chanAt(s);
    if (f.waterY(c.x, c.z, f.tField).h / pk > 0.01) return s;
  }
  return s0;
}
/* 湿带在画面里的纵向占比（0~1），供 back 反馈用。
   2026-11-10 逐点诊断（__rigFillDiag）确认：湿区是沿沟道的**楔形** ——
   可见水头处收成尖端，越往上游越宽；且到达时间场含横向漫流延迟，
   横向 ±40 m 就 T>tField（还没漫到）。所以固定横向偏移采样必然全落干区：
     ±90 m: wet 0/24（全干）、±40 m: wet 3/24，24/24 都在画面内 —— 不是出画。
   改为沿**中心线**先找出湿区上游端点，再投影两端量纵向跨度：
   一定落在湿区，且正好对应「水带占画高」这个反馈量。 */
function rigFill(cam, f, s0, L) {
  const cs = v => Math.max(0, Math.min(L, v));
  const pk = Math.max(f.peak || 1, 1e-3);
  const wetAt = s => {
    const c = f.chanAt(cs(s));
    const w = f.waterY(c.x, c.z, f.tField);
    return { c, w, wet: w.h / pk > 0.005 };
  };
  let sWet = s0;
  for (let d = 0; d <= 900; d += 30) {
    const s = cs(s0 - d);
    if (wetAt(s).wet) sWet = s;
  }
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  let y0 = 9, y1 = -9, n = 0;
  for (const s of [sWet, (sWet + s0) / 2, s0]) {
    const { c, w, wet } = wetAt(s);
    if (!wet) continue;
    rigTmp.set(c.x, w.y, c.z).project(cam);
    if (rigTmp.z > 1 || Math.abs(rigTmp.x) > 1 || Math.abs(rigTmp.y) > 1) continue;
    n++; y0 = Math.min(y0, rigTmp.y); y1 = Math.max(y1, rigTmp.y);
  }
  return n >= 2 ? Math.max(0, Math.min(y1, 1) - Math.max(y0, -1)) / 2 : 0;
}
function updateRig(dt, mode) {
  const f = flood; if (!f || !f.chanAt) return;
  const cfg = RIG[mode], L = f.channel.lengthM;
  const cs = v => Math.max(0, Math.min(L, v));
  const snap = rig.mode !== mode || rig.snap;
  if (snap) {
    rig.mode = mode; rig.s = rigHead(f, L); rig.back = cfg.back; rig.snap = false;
    rig.cam0.copy(camera.position); rig.tgt0.copy(controls.target);
    rig.introT = 0; rig.intro0 = performance.now();
  } else {
    rig.s += (rigHead(f, L) - rig.s) * (1 - Math.exp(-dt * cfg.sRate));
    // 有界反馈：水占画太大就沿沟后退，太小就靠近；0.85~1.18 防低帧率振荡。
    if (rig.fill > 0) rig.back = clamp(rig.back * clamp(rig.fill / cfg.fill, 0.85, 1.18),
                                        cfg.backMin, cfg.backMax);
  }
  const sc = cs(rig.s - rig.back), c = f.chanAt(sc), t = rigTangent(sc, f, L);
  const px = c.x - t.z * cfg.lat, pz = c.z + t.x * cfg.lat;
  const aS = cs(rig.s + cfg.ahead), ac = f.chanAt(aS), aw = f.waterY(ac.x, ac.z, f.tField);
  const horiz = Math.hypot(px - ac.x, pz - ac.z);
  // 高度：跟随/航拍用目标俯角反解（固定「抬高 620 m」在源区会变成仰视、
  // 口岸又俯得太狠）；战术俯视用绝对高度 alt，看整条沟谷的空间关系。
  // 两者都由离地钳制兜底，绝不把相机塞进山体。
  let py = cfg.alt
    ? aw.y + cfg.alt
    : aw.y + 20 + horiz * Math.tan(cfg.pitch * Math.PI / 180);
  py = Math.max(py, groundAt(px, pz) + CAM_AUTO_CLEAR);
  const pitchNow = Math.atan2(py - (aw.y + 20), Math.max(horiz, 1)) * 180 / Math.PI;
  rig.pos.set(px, py, pz); rig.aim.set(ac.x, aw.y + 20, ac.z);
  const k = snap ? 1 : 1 - Math.exp(-dt * cfg.posRate);
  const kt = snap ? 1 : 1 - Math.exp(-dt * cfg.tgtRate);
  camera.position.lerp(rig.pos, k);
  controls.target.lerp(rig.aim, kt);
  // 摇臂式切入：按墙钟计时而不是钳制后的 dt —— 无头 SwiftShader 只有 0.25 fps，
  // 用 dt(≤0.1) 累加会让 1.5 s 的过渡拖到十几帧、几十秒都走不完。
  // 真机 60 fps 时两条路径观感一致，仍是平滑推入。
  if (rig.introT < 1) {
    rig.introT = Math.min(1, (performance.now() - rig.intro0) / (cfg.intro * 1000));
    const e = smooth(rig.introT);
    camera.position.lerpVectors(rig.cam0, rig.pos, e);
    controls.target.lerpVectors(rig.tgt0, rig.aim, e);
  }
  camera.lookAt(controls.target);
  // 过渡帧里相机还在半路，测出来的占画高是假值，会误导 back 反馈；等落位再测。
  rig.fill = rig.introT >= 1 ? rigFill(camera, f, rig.s, L) : 0;
  rig.dbg = { mode, back: Math.round(rig.back), pitch: +pitchNow.toFixed(1), s: Math.round(rig.s),
              fill: +rig.fill.toFixed(2), intro: +rig.introT.toFixed(2),
              clear: +(camera.position.y - groundAt(camera.position.x, camera.position.z)).toFixed(1) };
}
function updateDisasterFollow(dt) {
  if (followSnap) { rig.snap = true; followSnap = false; }
  updateRig(dt, 'follow');
}
function updateCineCamera(dt) {
  if (cineSnap) { rig.snap = true; cineSnap = false; }
  updateRig(dt, 'cine');
}
function enableCine(on) {
  cineCam = on;
  cineSnap = on;
  $('btn-flood').classList.toggle('active', on);
  if (on) {
    if (state.engine !== 'three') setEngine('three');
    state.layers.flood = true;
    state.layers.debris = true;
    state.layers.spray = true;
    state.layers.field = false;
    $('layer-list').querySelectorAll('input').forEach(el => {
      el.checked = !!state.layers[el.dataset.layer];
    });
    applyLayers();
    autoFly = false;
    state.rotating = false;
    controls.autoRotate = false;
    $('btn-rotate').classList.remove('active');
    pushLog('洪水航拍已开启：GPU 高度场水面、前锋泡沫、碎冰翻滚与飞溅扬尘；镜头跟随水头。', 'info', state.t);
  } else {
    applyLayers();
    pushLog('退出洪水航拍，回到自由视角。', 'info', state.t);
  }
}
const markFloodJump = () => { if (flood) flood.markJump(); };

/* ------------------------------ UI ------------------------------ */
function buildUI() {
  $('stage-list').innerHTML = STAGES.map((s, i) => `
    <div class="stage-item" data-idx="${i}">
      <span class="stage-num">${i + 1}</span>
      <span class="stage-txt"><b>${s.name}</b></span>
      <small class="stage-time">${fmtClock(s.r * BASE_TOTAL)}</small>
    </div>`).join('');
  $('stage-list').querySelectorAll('.stage-item').forEach(el => {
    el.addEventListener('click', () => jumpToStage(+el.dataset.idx));
  });

  // 图层按组渲染：组标题 + 两列开关，避免 14 个复选框平铺成一堵墙
  const groups = [];
  LAYERS.forEach(l => {
    let g = groups.find(x => x.name === l.group);
    if (!g) groups.push(g = { name: l.group, items: [] });
    g.items.push(l);
  });
  $('layer-list').innerHTML = groups.map(g => `
    <div class="lg-title">${g.name}</div>
    <div class="lg-grid">${g.items.map(l => `
      <label class="layer-item"><input type="checkbox" data-layer="${l.id}" ${l.on ? 'checked' : ''}>${l.label}</label>`).join('')}
    </div>`).join('');
  $('layer-count').textContent = `${LAYERS.filter(l => l.on).length}/${LAYERS.length} 开启`;
  $('layer-list').querySelectorAll('input').forEach(el => {
    el.addEventListener('change', () => {
      const l = LAYERS.find(x => x.id === el.dataset.layer);
      state.layers[el.dataset.layer] = el.checked;
      if (l && l.alias) l.alias.forEach(k => { state.layers[k] = el.checked; });
      applyLayers();
    });
  });

  $('speeds').innerHTML = SPEEDS.map(s =>
    `<button class="speed ${s === state.speed ? 'active' : ''}" data-speed="${s}">${s}×</button>`).join('');
  $('speeds').querySelectorAll('.speed').forEach(el => {
    el.addEventListener('click', () => {
      state.speed = +el.dataset.speed;
      $('speeds').querySelectorAll('.speed').forEach(b => b.classList.toggle('active', b === el));
    });
  });

  $('sect-body').innerHTML = SECTIONS.map((s, i) => `
    <tr data-sec="${i}"><td>${s.name}</td><td>${s.q.toFixed(2)}</td><td>${s.depth.toFixed(2)}</td><td>${s.v.toFixed(2)}</td><td>${s.vmax.toFixed(2)}</td></tr>`).join('');

  $('tl-marks').innerHTML = STAGES.map((s, i) =>
    `<div class="tl-mark" data-idx="${i}" style="left:${s.r * 100}%"></div>`).join('');
  $('tl-marks').querySelectorAll('.tl-mark').forEach(el => {
    el.addEventListener('click', ev => { ev.stopPropagation(); jumpToStage(+el.dataset.idx); });
  });

  drawSpark();
}

/* 表 4 的两个响应量各给一张 ECharts 小图，并排放：
   左「到达时间」随物源增大而变短，右「洪峰流量」随物源增大而变长。
   原先用双 y 轴把两条曲线叠在一张图里，会被读成「洪峰比到达时间低」，
   所以拆成两张单轴图；图上不写数值（上方 4 个数字卡已经有了），
   只画曲线 + 当前位置的红色虚线与高亮点，避免同一数字出现两遍。 */
const rgbaOf = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

function sparkOption(name, unit, color, key, now, digits) {
  const data = SCENARIOS.map(x => [x.v, +key(x).toFixed(digits)]);
  const legendName = `${name} / ${unit}`;
  return {
    animationDuration: 280,
    grid: { left: 1, right: 8, top: 24, bottom: 4, containLabel: true },
    legend: {
      data: [legendName], left: 0, top: 0, itemWidth: 9, itemHeight: 6,
      itemGap: 4, icon: 'roundRect',
      textStyle: { fontSize: 9, color: '#b7c6dc' },
    },
    tooltip: {
      trigger: 'axis', confine: true,
      backgroundColor: 'rgba(10,20,36,.94)', borderColor: '#2f4564', borderWidth: 1,
      padding: [5, 7],
      textStyle: { fontSize: 10, color: '#e6edf7' },
      formatter: p => `${p[0].data[0].toFixed(2)} 亿 m³<br/>${name} ${p[0].data[1].toFixed(digits)} ${unit}`,
    },
    xAxis: {
      type: 'value', min: 0.1, max: 1.8, splitLine: { show: false },
      axisLine: { lineStyle: { color: '#2f4564' } }, axisTick: { show: false },
      axisLabel: {
        fontSize: 8, color: '#8496b0', margin: 5,
        formatter: v => (Math.abs(v - 0.1) < 1e-6 || Math.abs(v - 1.8) < 1e-6) ? v.toFixed(1) : '',
      },
    },
    yAxis: {
      type: 'value', splitNumber: 2,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { fontSize: 8, color: '#8496b0', margin: 4, formatter: v => Math.round(v * 10) / 10 },
      splitLine: { lineStyle: { color: 'rgba(47,69,100,.5)', type: 'dashed' } },
    },
    series: [{
      name: legendName, type: 'line', data, smooth: true,
      symbol: 'circle', symbolSize: 3.2,
      lineStyle: { width: 1.6, color }, itemStyle: { color },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: rgbaOf(color, .26) },
          { offset: 1, color: rgbaOf(color, 0) },
        ]),
      },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#f87171', width: 1, type: 'dashed', opacity: .75 },
        label: { show: false }, data: [{ xAxis: state.vol }],
      },
      markPoint: {
        symbol: 'circle', symbolSize: 7, silent: true,
        data: [{ coord: [state.vol, +now.toFixed(digits)] }],
        itemStyle: { color, borderColor: '#0a1424', borderWidth: 1.4 },
        label: { show: false },
      },
    }],
  };
}

function drawSpark() {
  if (!window.echarts) {
    // 本地静态服务器是单线程的：与地形/影像同时抢连接时 echarts.min.js 可能被拒，
    // 这里补拉一次，避免图表区留一片空白。
    if (!drawSpark.retried) {
      drawSpark.retried = true;
      const tag = document.createElement('script');
      tag.src = './lib/echarts.min.js?r=' + Date.now();
      tag.onload = () => drawSpark();
      document.head.appendChild(tag);
    }
    return;
  }
  const hostA = $('spark-arrival'), hostB = $('spark-q');
  if (!hostA || !hostB) return;
  if (!chartArrival) chartArrival = echarts.init(hostA, null, { renderer: 'canvas' });
  if (!chartFlow) chartFlow = echarts.init(hostB, null, { renderer: 'canvas' });
  const s = interpScenario(state.vol);
  chartArrival.setOption(
    sparkOption('到达时间', 'min', '#7dd3fc', x => x.arrival / 60, s.arrival / 60, 1), true);
  chartFlow.setOption(
    sparkOption('洪峰流量', '万m³/s', '#fbbf24', x => x.q, s.q, 2), true);
}

function applyLayers() {
  const L = state.layers;
  // 卫星影像关 → 切到 DEM 晕渲底图（同一套真实高程，不新建几何）
  terrainMat.map = L.imagery ? texSat : texHill;
  terrainMat.color.setHex(L.imagery ? 0xffffff : 0xd9dde0);
  terrainMat.needsUpdate = true;
  // 程序化细节由 uniform 开关控制，不重建几何、不换材质。
  // 岸边细节着色器画的是「常水位河道 + 规则 V 形流纹 + 白泡沫带」，
  // 洪水层开启时必须压掉，否则规则白纹会盖在真实水面上像一块编织布。
  bankUniforms.uBankOn.value = L.bank && !L.flood ? 1 : 0;
  facadeUniforms.uFacadeOn.value = L.facade ? 1 : 0;
  contourMesh.visible = L.contour;
  // 跟拍模式隐藏彩色态势叠加层：贴近灾害时巨大的前锋球 / 圆环示意符号
  // 会盖住真实水面与地形，正是「看不到灾害」的另一半原因
  hazardMesh.visible = L.hazard && !immersiveCam();
  hazardGlow.visible = L.hazard && !immersiveCam();
  // 实景洪水水面开时，旧的「示意流深场」自动让位，避免两层水叠在一起
  flowMesh.visible = L.field && !L.flood;
  if (flood) flood.setLayers(L);
  frontMarker.visible = L.channel && !immersiveCam();
  channelLine.visible = L.channel && !immersiveCam();
  buildings.forEach(m => { m.visible = L.buildings; });
  glacierGroup.visible = L.glacier;
  // 堰塞湖蓝饼、受灾范围圈、节点小球与地名标签也都是态势标注，一并收掉
  lakeMesh.visible = L.lake && !immersiveCam();
  impactRing.visible = L.lake && !immersiveCam();
  impactFill.visible = L.lake && !immersiveCam();
  nodeGroup.visible = L.nodes && !immersiveCam();
  labelEls.forEach(el => { el.style.display = L.labels && !immersiveCam() ? '' : 'none'; });
  // 图层计数跟着实际勾选数走（含别名位），不在每个入口各写一遍
  $('layer-count').textContent = `${LAYERS.filter(x => L[x.id]).length}/${LAYERS.length} 开启`;
  if (state.engine === 'cesium') syncCesiumLayers();
}

function updatePanels(f) {
  const s = f.s, st = STAGES[f.stageIdx];
  // 顶部 HUD 位双态：未开演 = 演示介绍；开演后 = 阶段播报。二者共用一个位置，
  // 避免标题长期占着地图顶部。时钟仍只在底部时间轴出现一次。
  $('stage-intro').classList.toggle('hidden', !introMode);
  $('stage-hud').classList.toggle('hidden', introMode);
  if (!introMode) {
    $('hud-idx').textContent = `${f.stageIdx + 1}/${STAGES.length}`;
    $('hud-stage').textContent = st.name;
    $('hud-desc').textContent = st.desc;
    $('stage-hud').classList.toggle('crit', st.lvl === 'crit');
  }
  const node = NODES.find(n => n.id === st.node);
  $('focus-name').textContent = node.name;
  $('focus-sub').textContent = node.sub;
  // 前缘行程三项：累计传播 / 当前高程 / 距口岸。
  // 已删：当前时刻（=时间轴）、当前断面名（=上方标题）、口岸洪峰（=右侧情景卡洪峰流量）
  $('kpi-grid').innerHTML = [
    { k: '累计传播', v: f.dist.toFixed(1), u: 'km', e: '沟道弧长' },
    { k: '当前高程', v: Math.round(f.elev), u: 'm', e: 'DEM 采样' },
    { k: '距口岸', v: fmtDur(f.remain).replace(' min ', ':').replace(' s', ''), u: '', e: '表 4 插值' },
  ].map(x => `<div class="kpi"><span>${x.k}</span><b>${x.v}<small>${x.u}</small></b><em>${x.e}</em></div>`).join('');
  $('scenario-kpi').innerHTML = [
    { k: '到达时间', v: fmtDur(s.arrival), u: '' },
    { k: '平均流深', v: s.depth.toFixed(2), u: 'm' },
    { k: '最大流速', v: s.vmax.toFixed(2), u: 'm/s' },
    { k: '洪峰流量', v: s.q.toFixed(2), u: '万m³/s' },
  ].map(x => `<div class="sk"><span>${x.k}</span><b>${x.v}<small>${x.u}</small></b></div>`).join('');
  $('vol-value').textContent = state.vol.toFixed(2);
  $('tl-time').textContent = f.clock;
  $('tl-total').textContent = `总历时 ${fmtDur(f.total)}`;
  $('tl-fill').style.width = `${f.ratio * 100}%`;
  $('tl-cursor').style.left = `${f.ratio * 100}%`;
  // 左面板高亮跟随 HUD 双态：未开演一项都不亮（此时顶部是演示介绍，不是阶段）；
  // 开演后才高亮当前阶段，避免"还没推演就高亮第 1 阶段"的错位。
  document.querySelectorAll('.stage-item').forEach((el, i) =>
    el.classList.toggle('active', !introMode && i === f.stageIdx));
  const secName = f.section ? f.section.name : '';
  $('sect-body').querySelectorAll('tr').forEach(tr => {
    tr.classList.toggle('active', SECTIONS[+tr.dataset.sec].name === secName);
  });
}

/* 播控条下方的「各时刻发生了什么」小字行已按用户要求整块删除。
   保留函数签名作为空实现，调用点不必逐个删（异常另有 #fatal 与 Cesium 加载框）。 */
function pushLog() {}
function onStageChange(idx, f) {
  // 阶段切换不再写一行日志：阶段名已经在画面左上 HUD 和左侧列表高亮里出现，
  // 再往状态行塞一遍就是同一句话出现三次。状态行只留给「操作 / 异常 / 就绪」。
  // 播放时的镜头由 updateDisasterFollow 逐帧连续跟随灾害体，不再按阶段 flyToNode
  // —— 阶段跳飞正是「镜头晃动 / 看不到灾害」的根因；Cesium 侧由地球自身运镜。
}
function jumpToStage(idx) {
  introMode = false;
  const f = computeFrame(0, state.vol);
  state.t = STAGES[idx].r * f.total;
  autoFly = false; markFloodJump();
  lastStageIdx = stageIndexAt(state.t / f.total);
  if (state.engine !== 'cesium') flyToNode(NODES.findIndex(n => n.id === STAGES[idx].node));
  pushLog(`跳转至阶段 ${idx + 1}：${STAGES[idx].name}`, 'info', state.t);
  refresh();
}
function jumpToNode(idx) {
  introMode = false;
  const f = computeFrame(0, state.vol);
  const target = NODES[idx].t;
  let best = 0, bd = Infinity;
  for (let i = 0; i <= 200; i++) {
    const r = i / 200;
    const d = Math.abs(frontPath(r) - target);
    if (d < bd) { bd = d; best = r; }
  }
  state.t = best * f.total;
  autoFly = false; markFloodJump();
  lastStageIdx = stageIndexAt(best);
  if (state.engine !== 'cesium') flyToNode(idx);
  pushLog(`聚焦：${NODES[idx].name}`, 'info', state.t);
  refresh();
}
function bindEvents() {
  $('btn-play').addEventListener('click', () => {
    if (!state.playing) introMode = false;   // 首次点「播放」＝开始推演，顶部从介绍切阶段
    state.playing = !state.playing;
    autoFly = state.playing;
    if (autoFly) { flight = null; followSnap = true; }
    $('btn-play').textContent = state.playing ? '暂停' : '播放';
    if (state.playing && state.t >= computeFrame(0, state.vol).total - 1) state.t = 0;
  });
  $('btn-prev').addEventListener('click', () => { introMode = false; autoFly = false; markFloodJump(); state.t = Math.max(0, state.t - 30); refresh(); });
  $('btn-next').addEventListener('click', () => {
    introMode = false; autoFly = false; markFloodJump();
    state.t = Math.min(computeFrame(0, state.vol).total, state.t + 30);
    refresh();
  });
  $('btn-replay').addEventListener('click', () => {
    introMode = false;
    state.t = 0; state.playing = true; autoFly = true; lastStageIdx = -1; markFloodJump();
    $('btn-play').textContent = '暂停';
    if (state.engine === 'cesium') resetCesiumView();
    else { flight = null; followSnap = true; }   // 不再 setView('persp')，避免与连续跟拍打架
    refresh();
  });
  $('btn-reset').addEventListener('click', resetView);
  $('btn-port').addEventListener('click', () => {
    if (state.engine !== 'three') setEngine('three');
    autoFly = false; followSnap = false;   // 主动聚焦口岸，退出播放跟拍
    flyToBuildings();
    pushLog(`聚焦口岸聚落：${bldFocus ? bldFocus.count : 0} 栋 OSM 实测轮廓 · 程序化立面与勾边`, 'info', state.t);
  });
  $('btn-flood').addEventListener('click', () => enableCine(!cineCam));
  $('btn-rotate').addEventListener('click', () => {
    state.rotating = !state.rotating;
    controls.autoRotate = state.rotating;
    $('btn-rotate').classList.toggle('active', state.rotating);
  });
  $('btn-about').addEventListener('click', () => $('about').classList.remove('hidden'));
  $('btn-about-close').addEventListener('click', () => $('about').classList.add('hidden'));
  $('about').addEventListener('click', e => { if (e.target === $('about')) $('about').classList.add('hidden'); });
  $('vol-slider').addEventListener('input', e => {
    state.vol = +e.target.value;
    const f = computeFrame(0, state.vol);
    state.t = Math.min(state.t, f.total);
    markFloodJump();
    drawSpark();
    refresh();
  });
  $('tl-track').addEventListener('click', e => {
    introMode = false;
    const rect = $('tl-track').getBoundingClientRect();
    const r = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    state.t = r * computeFrame(0, state.vol).total;
    autoFly = false; markFloodJump();
    lastStageIdx = stageIndexAt(r);
    refresh();
  });
  $('engine-switch').querySelectorAll('.engine-btn').forEach(b => {
    b.addEventListener('click', () => setEngine(b.dataset.engine));
  });
  $('btn-autocam').addEventListener('click', () => {
    state.autoCam = !state.autoCam;
    $('btn-autocam').classList.toggle('active', state.autoCam);
    postCesium({ type: 'setAutoCam', value: state.autoCam });
  });
}

/* ------------------------------ Cesium 双视图同步 ------------------------------ */
function postCesium(msg) {
  if (!cesiumFrame || !cesiumFrame.contentWindow) return;
  try {
    cesiumFrame.contentWindow.postMessage(Object.assign({ source: 'gyirong-twin' }, msg), '*');
  } catch (_) { /* iframe 未就绪时静默 */ }
}
function resetCesiumView() {
  state.autoCam = false;
  $('btn-autocam').classList.remove('active');
  postCesium({ type: 'setAutoCam', value: false });
  postCesium({ type: 'flyHome' });
}
const cesiumTime = f => f.ratio * CESIUM_TIME_SCALE;

function syncCesiumLayers() {
  postCesium({
    type: 'setLayers',
    layers: Object.fromEntries(CESIUM_LAYER_KEYS.map(k => [k, state.layers[k]])),
  });
}
function sendCesiumState(instant = true) {
  const f = computeFrame(state.t, state.vol);
  syncCesiumLayers();
  postCesium({ type: 'setAutoCam', value: state.autoCam });
  postCesium({ type: 'setTime', t: cesiumTime(f), reset: true, instant });
  postCesium({ type: 'diagnose' });
  lastCesiumT = cesiumTime(f);
}
function syncCesium(f) {
  if (state.engine !== 'cesium' || !cesiumReady) return;
  const t = cesiumTime(f);
  // 连续播放逐帧推进；跳转（拖时间轴 / 点阶段 / ±30 s / 改情景）重置建筑与流场帧缓存
  const jump = Math.abs(t - lastCesiumT) > 25;
  lastCesiumT = t;
  postCesium({ type: 'setTime', t, reset: jump, instant: jump });
}
function setEngine(engine) {
  if (engine !== 'three' && engine !== 'cesium') return;
  if (engine === state.engine && (engine === 'three' || cesiumRequested)) return;
  state.engine = engine;
  const isC = engine === 'cesium';
  document.body.classList.toggle('cesium', isC);
  $('engine-switch').querySelectorAll('.engine-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.engine === engine));
  $('labels').style.display = isC ? 'none' : '';
  $('scene').style.visibility = isC ? 'hidden' : '';
  $('lg-src').textContent = isC
    ? '底图：Cesium 三维地球 · 真实 DEM 地形 · Esri 离线影像金字塔 · glTF 建筑示意重建'
    // 与 index.html 图例里的初始文案保持一致（切回沙盘时不要丢掉程序化细节说明）
    : '底图：Terrarium/SRTM DEM · Esri World Imagery · OSM 建筑轮廓　|　洪水层：GPU 高度场 + 亚网格连续曲面 + 粒子（宏观淹没范围取自既有真实场，波动/泡沫/碎冰为视觉合成）';
  $('layer-list').querySelectorAll('input').forEach(el => {
    const off = isC && THREE_ONLY_LAYERS.includes(el.dataset.layer);
    el.disabled = off;
    el.closest('.layer-item').classList.toggle('disabled', off);
  });
  if (isC) {
    $('cesium-frame').classList.add('on');
    if (!cesiumRequested) {
      // 懒加载：首次切换才创建第二个 WebGL 上下文
      cesiumRequested = true;
      cesiumReady = false;
      $('cesium-loading').classList.add('on');
      const f = computeFrame(state.t, state.vol);
      cesiumFrame.src = `./cesium_embed.html?embed=1&t=${Math.round(cesiumTime(f))}`;
      pushLog('切换到 Cesium 三维地球：22 km 全景俯视，点画布右上「自动运镜」可跟随前锋近景。', 'info', state.t);
    } else if (cesiumReady) {
      sendCesiumState(true);
      pushLog('切回 Cesium 三维地球（时间轴已同步）。', 'info', state.t);
    }
  } else {
    $('cesium-frame').classList.remove('on');
    $('cesium-loading').classList.remove('on');
    pushLog('切回本地实景沙盘（Three.js）。', 'info', state.t);
  }
}
function onCesiumMessage(ev) {
  const d = ev.data;
  if (!d || d.source !== 'gyirong-cesium' || !d.type) return;
  if (d.type === 'ready') {
    cesiumReady = true;
    cesiumDiag = d.dbg || null;
    $('cesium-loading').classList.remove('on');
    sendCesiumState(true);
    pushLog('Cesium 实景地球就绪：DEM 地形、影像瓦片、泥石流帧场与 glTF 建筑已加载。', 'info', state.t);
  } else if (d.type === 'diagnose') {
    cesiumDiag = d.dbg || null;
  } else if (d.type === 'error') {
    cesiumErr = String(d.message || '未知错误');
    const box = $('cesium-loading');
    box.classList.add('on');
    box.innerHTML = `<b>Cesium 三维地球加载失败</b><small>${cesiumErr}</small>`;
    pushLog(`Cesium 加载失败：${cesiumErr}`, 'crit', state.t);
  }
  updateDiag();
}
function updateDiag() {
  if (!DIAG || !window.__dbg) return;
  try { $('diag').textContent = JSON.stringify(window.__dbg()); } catch (_) {}
}

/* ------------------------------ 主循环 ------------------------------ */
function refresh() {
  const f = computeFrame(state.t, state.vol);

  // 三维只「演」论文的时间线，不产出数字
  hazardMat.uniforms.uFront.value = f.path;
  hazardMat.uniforms.uGain.value = clamp((f.s.q - 0.31) / 18.5, 0, 1) * 0.22;
  // 到场时间场按 390 s 口径生成；把演示比例映射到该口径，情景只改变演进快慢
  flowUniforms.uTime.value = f.ratio * FIELD_T_SCALE;
  // 洪水实景层：宏观水位取论文表 4 平均流深（口径 B），到达时间沿用既有真实场
  if (flood) flood.setFrame(f.ratio, f.s.depth);

  const c = chanAt(f.path * channel.lengthM);
  frontMarker.position.set(c.x, c.y + 95, c.z);
  frontMarker.visible = state.layers.channel && !cineCam && f.ratio < 0.999;

  // 源区冰川失稳后消融（相对坐标，整组缩放不会甩离沟谷）
  const melt = clamp(f.ratio / 0.14, 0, 1);
  glacierGroup.scale.setScalar(1 - 0.82 * melt);
  glacierGroup.visible = state.layers.glacier && melt < 0.995;

  // 堰塞水体：冲击后回水成湖，受灾范围圈同步显现
  const lakeK = clamp((f.ratio - 0.97) / 0.03, 0, 1);
  lakeKVal = lakeK;
  lakeMesh.material.opacity = 0.62 * lakeK;
  impactRing.material.opacity = 0.9 * lakeK;
  impactFill.material.opacity = 0.20 * lakeK;
  lakeMesh.visible = state.layers.lake && !cineCam && lakeK > 0.01;
  // 受灾范围圈与虚线圆是态势符号，航拍画面里去掉，避免「示意图」感
  impactRing.visible = state.layers.lake && !cineCam && lakeK > 0.01;
  impactFill.visible = state.layers.lake && !cineCam && lakeK > 0.01;

  // OSM 建筑按论文「27 处被夷平」做示意损毁：只做下沉/换色，不改真实轮廓
  const hitK = clamp((f.ratio - 0.985) / 0.015, 0, 1);
  buildings.forEach(m => {
    const u = m.userData;
    const k = clamp((hitK - u.delay * 0.35) / 0.65, 0, 1);
    m.position.y = -u.hh * 0.62 * k;         // 几何本身已平移到 baseY
    m.rotation.z = 0.16 * k * (u.delay > 0.5 ? 1 : -1);
    // 按材质命名约定整组切换损毁色板；换成 GY_damage 后窗格 shader 自然不再生效
    applyDamage(m, k);
  });

  if (f.stageIdx !== lastStageIdx) {
    if (lastStageIdx >= 0) onStageChange(f.stageIdx, f);
    lastStageIdx = f.stageIdx;
  }
  updatePanels(f);
  syncCesium(f);
  updateDiag();
}

let prev = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;
  avgFrame = avgFrame * 0.9 + dt * 0.1;

  if (state.playing) {
    const f = computeFrame(state.t, state.vol);
    state.t = Math.min(f.total, state.t + dt * SIM_SECONDS_PER_REAL_SECOND * state.speed);
    if (state.t >= f.total) {
      state.playing = false; autoFly = false;
      $('btn-play').textContent = '播放';
      pushLog('推演结束：灾害体到达吉隆口岸', 'crit', state.t);
    }
    refresh();
  }

  // 三维地球视图：暂停本地 WebGL 渲染与标签投影，避免两个上下文抢 GPU
  if (state.engine === 'cesium') return;

  // 洪水航拍优先；播放时默认走战术俯视机位（逐帧连续跟随，不再按阶段跳飞）
  if (cineCam) updateCineCamera(dt);
  else if (autoFly && !flight) updateDisasterFollow(dt);
  // 洪水实景层：GPU 子步长推进（ping-pong 计算 pass）必须在主场景渲染之前；
  // 视距只改水面视觉放大系数，不改 KPI 数值
  if (flood && flood.enabled) {
    const dist = camera.position.distanceTo(controls.target);
    flood.setViewDistance(dist);
    // ?rig= 定点：视距参数已按当前相机更新，此刻再定位一次，
    // 保证「可见水头」用的是正确的水深放大系数（boot 里 peak 还是初始 1.0）
    if (rigPending) { rigPlaceInfo = placeRigAt(...rigPending); rigPending = null; }
    flood.update(dt, now);
  }

  hazardMat.uniforms.uTime.value = now / 1000;
  bankUniforms.uBankTime.value = now / 1000;
  // 态势叠加层按视距自适应：
  // 远景（>9 km）山脊会完全挡住谷底 → 关闭深度测试 + 沿法向加宽 + 全不透明；
  // 近景（<4 km）改用真实遮挡并淡出，否则几百米宽的叠加层会把口岸建筑与岸边糊住。
  const camDist = camera.position.distanceTo(controls.target);
  const nearK = clamp((9000 - camDist) / 5000, 0, 1);
  hazardShared.uWidthBoost.value = clamp((camDist - 9000) / 9000, 0, 1) * 110;
  // applyLayers 只在图层切换时调用，播放开始/结束不会触发，
  // 所以每帧统一同步一次「沉浸式跟拍」的可见性。
  const imm = immersiveCam();
  const fNow = computeFrame(state.t, state.vol);
  hazardMesh.visible = state.layers.hazard && !imm;
  hazardGlow.visible = state.layers.hazard && !imm;
  channelLine.visible = state.layers.channel && !imm;
  nodeGroup.visible = state.layers.nodes && !imm;
  frontMarker.visible = state.layers.channel && !imm && fNow.ratio < 0.999;
  lakeMesh.visible = state.layers.lake && !imm && lakeKVal > 0.01;
  impactRing.visible = state.layers.lake && !imm && lakeKVal > 0.01;
  impactFill.visible = state.layers.lake && !imm && lakeKVal > 0.01 && nearK < 0.55;
  // 跟拍模式压低「态势叠加层」，让真实水面 / 泡沫 / 碎冰成为画面主体；
  // 全景模式保留叠加层以便在 22 km 尺度上辨识沟道
  const overlayFade = state.layers.flood ? (imm ? 0.16 : 0.58) : 1;
  hazardShared.uAlpha.value = (1 - 0.68 * nearK) * overlayFade;
  const wantDepth = nearK > 0.35;
  if (wantDepth !== overlayDepth) {
    overlayDepth = wantDepth;
    [hazardMat, hazardGlowMat, impactFill.material, impactRing.material,
     channelLine.material, frontMarker.children[0].material,
     frontMarker.children[1].material].forEach(m => { m.depthTest = wantDepth; });
  }
  impactRing.material.opacity = 0.9 * lakeKVal * (1 - 0.55 * nearK);
  lakeMesh.material.opacity = 0.62 * lakeKVal * (1 - 0.35 * nearK);
  // 沟道细管半径 75 m 是为 22 km 全景定的；近景会变成一条亮青塑料带，
  // 压低透明度让着色器画的深青水面与白色泡沫湿边透出来。
  channelLine.material.opacity = (0.88 - 0.60 * nearK) *
    (imm ? 0.22 : state.layers.flood ? 0.62 : 1);
  if (frontMarker.children[1]) {
    frontMarker.children[1].scale.setScalar(1 + 0.16 * Math.sin(now / 320));
  }
  updateFlight(now);
  // 必须把 dt 传给 update()：r160 才按真实时间算自动旋转角速度，
  // 否则 autoRotate 走「每帧固定角」分支，低帧率下慢到几乎不动（表现为按钮没用）。
  controls.update(dt);
  // 所有运镜算完之后再做地形安全钳制，这是防穿模的最后一道保险
  enforceCameraClearance();

  // 自适应分辨率：帧时间偏高先降像素，而不是掉帧
  if (avgFrame > 0.030 && dpr > 1) {
    dpr = Math.max(1, dpr - 0.25);
    renderer.setPixelRatio(dpr);
    avgFrame = 1 / 60;
  } else if (avgFrame < 0.013 && dpr < MAX_DPR) {
    dpr = Math.min(MAX_DPR, dpr + 0.25);
    renderer.setPixelRatio(dpr);
    avgFrame = 1 / 60;
  }

  // HTML 地名标签跟随真实沟道上的三维节点；源区附近节点密集，做贪心避让
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  const v = new THREE.Vector3();
  const cands = [];
  nodeMarks.forEach((m, i) => {
    const el = labelEls[i];
    if (!state.layers.labels || !state.layers.nodes || immersiveCam()) { el.style.display = 'none'; return; }
    v.copy(m.position).project(camera);
    if (v.z > 1 || v.z < -1) { el.style.display = 'none'; return; }
    cands.push({
      el,
      x: clamp((v.x * 0.5 + 0.5) * w, 110, w - 110),
      y: clamp((-v.y * 0.5 + 0.5) * h - 10, 26, h - 26),
    });
  });
  const placed = [];
  for (const c of cands) {
    let x = c.x, y = c.y, ok = false;
    for (let k = 0; k < 8 && !ok; k++) {
      ok = !placed.some(p => Math.abs(p.x - x) < 128 && Math.abs(p.y - y) < 19);
      if (!ok) {
        if (k % 2 === 0) y -= 21;
        else x += (k % 4 === 1 ? 140 : -140);
      }
    }
    if (!ok) { c.el.style.display = 'none'; continue; }
    placed.push({ x, y });
    c.el.style.display = '';
    c.el.style.left = `${clamp(x, 110, w - 110)}px`;
    c.el.style.top = `${clamp(y, 26, h - 26)}px`;
  }

  renderer.render(scene, camera);
}

function fatal(err) {
  console.error(err);
  const el = $('fatal');
  el.classList.remove('hidden');
  el.textContent = `场景初始化失败：${err && err.message ? err.message : err}。请确认通过 http 静态服务打开（不要直接双击 file:// 打开），且 data/ 与 lib/ 下文件齐全。`;
}

async function boot() {
  await loadAssets();
  initScene();
  // 程序化资产层：距离场先于地形材质编译，立面窗格注入到色板里的 GY_wall
  buildBankField();
  attachFacade(material('GY_wall'), facadeUniforms);
  buildTerrain();
  buildSkirt();
  await buildFlowField();
  buildChannelLine();
  buildHazardStrip();
  buildOSMBuildings();
  buildGlacier();
  buildLakeAndImpact();
  buildNodes();
  buildFlood();
  // 锚点缺失直接 throw，不允许静默降级（医院孪生那条经验）
  assertAnchors(scene, [
    'anchor_terrain', 'anchor_contour', 'anchor_channel', 'anchor_hazard',
    'anchor_front', 'anchor_flow', 'anchor_glacier', 'anchor_lake', 'anchor_nodes',
  ]);
  buildings.forEach(g => assertAnchors(g, [g.userData.anchorName]));
  buildUI();
  bindEvents();
  cesiumFrame = $('cesium-frame');
  window.addEventListener('message', onCesiumMessage);

  // 支持 ?t=<秒>&vol=<亿m³> 直接定位到指定时刻/情景，便于分享与截图验收
  const qs = new URLSearchParams(location.search);
  const qVol = parseFloat(qs.get('vol'));
  if (Number.isFinite(qVol)) {
    state.vol = clamp(qVol, 0.10, 1.80);
    $('vol-slider').value = String(state.vol);
  }
  const initTotal = computeFrame(0, state.vol).total;
  const qT = parseFloat(qs.get('t'));
  if (Number.isFinite(qT)) { state.t = clamp(qT, 0, initTotal); introMode = false; }
  lastStageIdx = stageIndexAt(state.t / initTotal);
  applyLayers();
  drawSpark();
  refresh();
  // 就绪只报一行：网格尺寸等实现细节已写进「数据与说明」，不再刷满状态行
  pushLog(`实景三维就绪：真实 DEM + Esri 卫星影像 + OSM 建筑 ${buildings.length} 栋 + 洪水演进层（GPU ${FLOOD_CONSTANTS.SW}×${FLOOD_CONSTANTS.SH}），左键旋转 · 滚轮按光标位置缩放。`, 'info', state.t);
  // ?engine=cesium 直接用三维地球视图打开（截图验收 / 分享指定帧）
  if (qs.get('engine') === 'cesium') setEngine('cesium');
  // 航拍 / 跟拍 / 定点构图都是「已开演」的验收态，顶部直接进阶段播报，
  // 否则分享出去的帧会出现「标题介绍 + 跟拍画面」的不一致。
  if (qs.get('cine') === '1' && qs.get('engine') !== 'cesium') { introMode = false; enableCine(true); }
  // ?follow=1 静态进入全链条跟拍（不自动播放时间），供多时刻构图验收
  if (qs.get('follow') === '1' && qs.get('engine') !== 'cesium') {
    introMode = false; state.playing = false; autoFly = true; followSnap = true;
  }
  // ?rig=后退弧长,横向偏移,离水面高度,瞄准前移 —— 构图验收定点入口（不影响默认播放）
  const qRig = (qs.get('rig') || '').split(',').map(Number);
  if (qRig.length === 4 && qRig.every(Number.isFinite) && qs.get('engine') !== 'cesium') {
    introMode = false; rigStatic = true; rigPending = qRig;   // 延后一帧，等 flood 视距参数随相机稳定
  }
  window.__rigPlace = placeRigAt;
  window.__rigPlaceInfo = () => rigPlaceInfo;
  // 构图诊断：逐点输出 rigFill 的采样结果（相对水深 + 投影 NDC），
  // 用来定位「fill 恒为 0」到底是湿点判定没过、还是投影落到画面外。
  window.__rigFillDiag = (halfW = 90) => {
    const f = flood; if (!f || !f.chanAt) return null;
    const L = f.channel.lengthM, cs = v => Math.max(0, Math.min(L, v));
    const pk = Math.max(f.peak || 1, 1e-3);
    const pv = new THREE.Vector3();
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const pts = [];
    for (let i = 0; i <= 11; i++) {
      const s = cs(rig.s - i * 40), c = f.chanAt(s), t = rigTangent(s, f, L);
      for (const lat of [-halfW, halfW]) {
        const x = c.x - t.z * lat, z = c.z + t.x * lat;
        const w = f.waterY(x, z, f.tField);
        pv.set(x, w.y, z).project(camera);
        pts.push({ i, lat, hp: +(w.h / pk).toFixed(3),
                   ndc: [+pv.x.toFixed(2), +pv.y.toFixed(2), +pv.z.toFixed(2)],
                   inView: !(pv.z > 1 || Math.abs(pv.x) > 1 || Math.abs(pv.y) > 1) });
      }
    }
    return { s: Math.round(rig.s), halfW, peak: +pk.toFixed(1), fill: rig.fill,
             back: Math.round(rig.back), pts };
  };
  window.__flood = flood;   // 诊断出口：供无头浏览器做分层性能与水文复算
  // 镜头诊断：验证「用户拖动后不再被抢回」与「相机离地余量恒为正」
  window.__cam = () => {
    const f = computeFrame(state.t, state.vol);
    const c = chanAt(f.path * channel.lengthM);
    const hz = new THREE.Vector3(c.x, c.y + 100, c.z);
    const wh = flood && flood.frontHint ? flood.frontHint() : null;
    const whv = wh ? new THREE.Vector3(wh.x, wh.y + 40, wh.z) : hz;
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const fr = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,
                                           camera.matrixWorldInverse));
    const g = groundAt(camera.position.x, camera.position.z);
    return {
      pos: camera.position.toArray().map(v => +v.toFixed(1)),
      target: controls.target.toArray().map(v => +v.toFixed(1)),
      cineCam, autoFly, rotating: state.rotating, autoCam: !!state.autoCam,
      flight: !!flight,
      t: +state.t.toFixed(1),
      dist: +camera.position.distanceTo(controls.target).toFixed(1),
      minDistance: controls.minDistance,
      enablePan: controls.enablePan,
      screenSpacePanning: controls.screenSpacePanning,
      leftButton: controls.mouseButtons.LEFT,
      ground: +g.toFixed(1),
      clearance: +(camera.position.y - g).toFixed(1),
      // 灾害体是否在视锥内、以及轨道中心离灾害多远 —— 「看得到灾害」的定量判据
      hazard: { x: +c.x.toFixed(1), y: +c.y.toFixed(1), z: +c.z.toFixed(1),
                path: +f.path.toFixed(3) },
      hazardInView: fr.containsPoint(hz),
      targetToHazard: +controls.target.distanceTo(hz).toFixed(1),
      camToHazard: +camera.position.distanceTo(hz).toFixed(1),
      // 真实洪水水头：播放跟拍的锚点，也是「画面里看得到灾害」的判据
      waterHead: wh ? { x: +wh.x.toFixed(1), y: +wh.y.toFixed(1),
                        z: +wh.z.toFixed(1) } : null,
      waterHeadInView: fr.containsPoint(whv),
      targetToWaterHead: +controls.target.distanceTo(whv).toFixed(1),
      camToWaterHead: +camera.position.distanceTo(whv).toFixed(1),
      // 两套前锋口径的水平差距（诚实暴露数据口径不一致）
      frontGap: wh ? +Math.hypot(c.x - wh.x, c.z - wh.z).toFixed(1) : null,
      rig: rig.dbg || null,
    };
  };
  /* ---------------- 镜头构图搜索（仅验收用，不参与正常播放） ----------------
     沿沟道弧长布置机位，扫描「后退弧长 / 横向偏移 / 离地高度 / 瞄准前移」，
     把真实水面点投影到画面里量出主体占画高、横向跨度与遮挡。
     上一轮实测的两条教训：机位沿直线后拉会在弯道切进侧壁（离地 −182 m），
     所以必须沿沟道走；俯角是几何的**结果**，不能手填常数再摆位置。 */
  window.__rigSearch = (opts = {}) => {
    const f = flood;
    if (!f || !f.chanAt) return { rows: [], err: 'no flood' };
    const L = f.channel.lengthM;
    const clampS = s => Math.max(0, Math.min(L, s));
    // 切线用 ±300 m 基线：沟道折线顶点间距中位数 63 m，±45 m 差分会让
    // 机位每经过一个顶点就跳一次方向，这是上一轮镜头晃动的物理来源。
    const smoothT = s => {
      const a = f.chanAt(clampS(s - 300)), b = f.chanAt(clampS(s + 300));
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
      return { x: dx / d, z: dz / d };
    };
    // frontS 是「到达时间 = 当前时刻」等值线，那里水深恰好 0；
    // 画面里真正能看见的水面在上游，按 50 m 步找第一个 h>2 的位置。
    let s0 = clampS(f.frontS || 0);
    const sFront = s0;
    for (let d = 0; d <= 1500; d += 50) {
      const s = clampS(s0 - d), c = f.chanAt(s);
      if (f.waterY(c.x, c.z, f.tField).h > 2) { s0 = s; break; }
    }
    const body = opts.body || 500, lead = opts.lead || 250, halfW = opts.halfW || 90;
    const pts = [], wetS = [];
    for (let i = 0; i <= 32; i++) {
      const s = clampS(s0 - body + (body + lead) * i / 32);
      const c = f.chanAt(s), t = smoothT(s);
      let hasWet = false;
      for (const lat of [-halfW, 0, halfW]) {
        const x = c.x - t.z * lat, z = c.z + t.x * lat;
        const w = f.waterY(x, z, f.tField);
        if (w.h > 1) hasWet = true;
        pts.push([x, w.y, z, w.h]);
      }
      if (hasWet) wetS.push(s);
    }
    const savePos = camera.position.clone(), saveTgt = controls.target.clone();
    const saveQ = camera.quaternion.clone();
    const backs = opts.backs || [600, 900, 1200, 1500];
    const lats = opts.lats || [-220, 0, 220];
    const hs = opts.hs || [160, 280, 420, 560];
    const aheads = opts.aheads || [0, 200, 400];
    const v = new THREE.Vector3(), dst = new THREE.Vector3();
    const headC = f.chanAt(s0), headW = f.waterY(headC.x, headC.z, f.tField);
    const wetPts = pts.filter(p => p[3] > 1).length;
    const rows = [];
    for (const back of backs) for (const lat of lats) for (const H of hs) for (const ahead of aheads) {
      const sc = clampS(s0 - back), c = f.chanAt(sc), t = smoothT(sc);
      const px = c.x - t.z * lat, pz = c.z + t.x * lat;
      const base = Math.max(f.waterY(px, pz, f.tField).y, groundAt(px, pz));
      const py = base + H;
      const aS = clampS(s0 + ahead), ac = f.chanAt(aS), aw = f.waterY(ac.x, ac.z, f.tField);
      const ax = ac.x, ay = aw.y + 20, az = ac.z;
      camera.position.set(px, py, pz);
      camera.lookAt(ax, ay, az);
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9, inN = 0;
      // 湿点单独统计：主体点云里大部分是干沟道，把它们算进「水体占画高」
      // 会得到 70% 的假象，截图却是八成山坡 —— 上一轮就栽在这里。
      let wx0 = 9, wx1 = -9, wy0 = 9, wy1 = -9, wetIn = 0, wetVis = 0, wetVisT = 0;
      for (let i = 0; i < pts.length; i++) {
        const wet = pts[i][3] > 1;
        v.set(pts[i][0], pts[i][1], pts[i][2]).project(camera);
        const inView = !(v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1);
        if (inView) {
          inN++;
          x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
          y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
          if (wet) {
            wetIn++;
            wx0 = Math.min(wx0, v.x); wx1 = Math.max(wx1, v.x);
            wy0 = Math.min(wy0, v.y); wy1 = Math.max(wy1, v.y);
          }
        }
        if (i % 10 || !wet) continue;
        wetVisT++;
        let blocked = false;
        for (let k = 1; k <= 7; k++) {
          const u = k / 8;
          if (groundAt(px + (pts[i][0] - px) * u, pz + (pts[i][2] - pz) * u) >
              py + (pts[i][1] - py) * u + 8) { blocked = true; break; }
        }
        if (!blocked) wetVis++;
      }
      v.set(headC.x, headW.y + 20, headC.z).project(camera);
      let headBlk = 0;
      for (let k = 1; k <= 12; k++) {
        const u = k / 13;
        if (groundAt(px + (headC.x - px) * u, pz + (headC.z - pz) * u) >
            py + (headW.y + 20 - py) * u) headBlk++;
      }
      const horiz = Math.hypot(px - ax, pz - az);
      rows.push({
        back, lat, H, ahead,
        dist: Math.round(camera.position.distanceTo(dst.set(ax, ay, az))),
        pitch: +(Math.atan2(py - ay, horiz) * 180 / Math.PI).toFixed(1),
        clear: Math.round(py - groundAt(px, pz)),
        // wH / wSpan 只算湿点；chanH 是整段沟道（含干坡），两者别混用
        wH: wetIn ? +((Math.min(wy1, 1) - Math.max(wy0, -1)) / 2 * 100).toFixed(1) : 0,
        wSpan: wetIn ? +(Math.min(wx1, 1) - Math.max(wx0, -1)).toFixed(2) : 0,
        wetInPct: wetPts ? Math.round(wetIn / wetPts * 100) : 0,
        chanH: inN ? +((Math.min(y1, 1) - Math.max(y0, -1)) / 2 * 100).toFixed(1) : 0,
        inPct: Math.round(inN / pts.length * 100),
        visPct: wetVisT ? Math.round(wetVis / wetVisT * 100) : null,
        headX: +v.x.toFixed(2), headY: +v.y.toFixed(2), headBlk,
      });
    }
    camera.position.copy(savePos); controls.target.copy(saveTgt); camera.quaternion.copy(saveQ);
    camera.updateMatrixWorld(true);
    return { sFront: Math.round(sFront), s0: Math.round(s0),
             sWet0: wetS.length ? Math.round(wetS[0]) : null,
             sWet1: wetS.length ? Math.round(wetS[wetS.length - 1]) : null,
             frontGap: Math.round(sFront - s0), pts: pts.length, wetPts, rows };
  };
  window.__ready = true;
  window.__dbg = () => ({
    ready: true,
    engine: state.engine, cesiumReady, cesiumErr,
    tCesium: +cesiumTime(computeFrame(state.t, state.vol)).toFixed(1),
    cesium: cesiumDiag,
    dem: `${meta.meshSize + 1}²`, imagery: `${texSat.image.width}×${texSat.image.height}`,
    channelKm: channel.lengthM / 1000, osmBuildings: buildings.length,
    grid: GRID, flowGrid: `${FIELD_GX}×${FIELD_GY}`,
    bank: `${bankField.width}×${bankField.height}`, bankOn: bankUniforms.uBankOn.value,
    facadeOn: facadeUniforms.uFacadeOn.value, sculpts: diagnose(),
    bldFocus: bldFocus && { count: bldFocus.count, x: Math.round(bldFocus.x), z: Math.round(bldFocus.z) },
    widthBoost: +hazardShared.uWidthBoost.value.toFixed(1),
    t: Math.round(state.t), path: +computeFrame(state.t, state.vol).path.toFixed(3),
    hazardFront: +hazardMat.uniforms.uFront.value.toFixed(3),
    hazardVisible: hazardMesh.visible,
    hazardDepthTest: hazardMat.depthTest,
    hazardVerts: hazardMesh.geometry.attributes.position.count,
    hazardYRange: (() => {
      const a = hazardMesh.geometry.attributes.position.array;
      let mn = 1e9, mx = -1e9;
      for (let i = 1; i < a.length; i += 3) { mn = Math.min(mn, a[i]); mx = Math.max(mx, a[i]); }
      return [Math.round(mn), Math.round(mx)];
    })(),
    triangles: renderer.info.render.triangles,
    cineCam, flood: flood ? flood.diagnose() : null,
    flowMeshVisible: flowMesh.visible,
    err: window.__err || '',
  });
  // 诊断出口：仅 ?diag=1 时把状态写进 DOM，供无头浏览器读取
  updateDiag();
  requestAnimationFrame(loop);
}
boot().catch(fatal);
window.addEventListener('error', e => { window.__err = String(e.message); fatal(e.error || e.message); });
