/* ==========================================================================
   sculpt_lab.js — 单图 → 程序化 Three.js 模型（img2threejs 2.0.1 方法论复刻）

   这是一页可跑的「迷你版 img2threejs」：左边一张参考图，右边由 spec 生成的
   可编辑 THREE.Group；按 8 个 build pass 逐层重建，每阶段过确定性门控才解锁下一阶段。

   刻意不复刻的部分（如实标注，见页面「边界与事实核对」）：
   · 没有 Agent Skill 宿主，没有 forge/ Python 门控脚本，没有 LLM / API Key；
     门控逻辑直接用 proc.js 的 validateSpec + 本文件的确定性检查。
   · 参考图是人工绘制的构图示意图，不是实测照片，所以不做像素级保真；
     背面 / 屋顶设备 / 真实尺度按区域标低置信。
   · 没有 AI 视觉评审：机械判定交给脚本，「像不像」由人在 side-by-side 里看。

   与吉隆实景沙盘零耦合：只复用本地 three.module.js r160 与 proc.js 的建模骨架，
   不加载 DEM / 影像 / OSM / 流场，不改动 app.js 与 index.html 的主流程。
   ========================================================================== */

import * as THREE from './lib/three.module.js?v=20261111a';
import { OrbitControls } from './lib/OrbitControls.js?v=20261111a';
import {
  material, makeSculpt, applyDamage, validateSpec, snapshotSpec,
  disposeSculpt, triangleCount, attachWindowGrid, SCULPT_PASSES,
} from './proc.js?v=20261111a';

const $ = id => document.getElementById(id);
const PASS_CN = {
  blockout: '体块', structural: '结构分件', form: '形体细化', material: '命名材质',
  surface: '程序化表面', lighting: '灯光', interaction: '运行时契约', optimization: '预算与重复系统',
};

/* 六条「决定身份的细节」：每条必须 mappedTo 真实组件或命名材质，
   pass 表示该细节在哪一阶段被解锁（对应参考图上的编号 1–6）。 */
const DETAILS = [
  { num: 5, id: '基座台地',       pass: 1, mappedTo: 'part_podium',  confidence: 0.88, note: '正面可见，两级台阶' },
  { num: 4, id: '居中门廊',       pass: 2, mappedTo: 'part_porch',   confidence: 0.82, note: '门洞与雨棚' },
  { num: 1, id: '平顶女儿墙',     pass: 3, mappedTo: 'part_parapet', confidence: 0.86, note: '藏式平顶轮廓' },
  { num: 2, id: '赭红檐带',       pass: 4, mappedTo: 'part_cornice', confidence: 0.90, note: '参考图取色 → 命名材质 GY_cornice，非贴图' },
  { num: 3, id: '成排方窗',       pass: 5, mappedTo: 'GY_wall',      confidence: 0.78, note: 'GLSL 窗格，不新增几何' },
  { num: 6, id: '屋顶旗杆',       pass: 7, mappedTo: 'part_flag',    confidence: 0.42, note: '背面不可见，按镜像推断' },
];

const CONFIDENCE = {
  overall: 0.71,
  regions: [
    { name: '正面立面', value: 0.88, note: '参考图可见' },
    { name: '侧墙与背面', value: 0.35, note: '单图不可见，按对称推断' },
    { name: '屋顶设备', value: 0.28, note: '未观察到，仅示意补充' },
    { name: '真实尺度', value: 0.00, note: '无测量依据，仅视觉比例' },
  ],
};

const params = { floors: 4, bays: 8, pitch: 0.12, win: 1, damage: 0, night: 0.35, budget: 12000 };
let passIndex = 0;
let current = null;
let reviews = [];
let lastGate = null;
let lastGateOk = true;
let injectedFault = false;
let disposeCount = 0;
let preGate = null;

/* 着色器 uniform 跨重建共享同一个对象引用，改 .value 立即生效 */
const winU = {
  uWinOn:     { value: 0 },
  uFloors:    { value: 4 },
  uBays:      { value: 8 },
  uWinDamage: { value: 0 },
  uNight:     { value: 0 },
};
attachWindowGrid(material('GY_wall'), winU);

const LAMP_MAT = new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffa040, emissiveIntensity: 0.9 });
LAMP_MAT.name = 'GY_lamp';
const FLAG_MAT = new THREE.MeshStandardMaterial({ color: 0xc8392f, roughness: 0.8, side: THREE.DoubleSide });
FLAG_MAT.name = 'GY_flag';
/* 从参考图檐带取色写进命名材质 —— 对应 img2threejs 的 material reference pipeline：
   flat paint 用 solid albedo，不需要下载贴图 */
const CORNICE_MAT = new THREE.MeshStandardMaterial({ color: 0x9c4638, roughness: 0.86 });
CORNICE_MAT.name = 'GY_cornice';

/* ------------------------------ 参考图 ------------------------------ */
(function mountReference() {
  const svg = $('ref-template').content.querySelector('svg');
  const xml = new XMLSerializer().serializeToString(svg);
  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  $('ref-img').src = uri;
  $('side-img').src = uri;
})();

/* ------------------------------ 场景 ------------------------------ */
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ canvas: $('cv'), antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 800);
camera.position.set(32, 20, 36);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 6, 0);

const ambient = new THREE.AmbientLight(0xa9c4d8, 1.15);
const key = new THREE.DirectionalLight(0xfff0d8, 2.1);
key.position.set(26, 34, 22);
const rim = new THREE.DirectionalLight(0x6fb6d8, 0.8);
rim.position.set(-24, 14, -26);
scene.add(ambient, key, rim);

const stage = new THREE.Group();          // 常驻地面，不参与每次重建
scene.add(stage);
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(46, 64),
  new THREE.MeshStandardMaterial({ color: 0x1d3240, roughness: 0.98, side: THREE.DoubleSide })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.42;
stage.add(ground);
const grid = new THREE.GridHelper(92, 46, 0x2b5568, 0x1d3a49);
grid.position.y = -1.40;
stage.add(grid);

let porchLight = null;                    // lighting pass 之后才出现
function setStageLight(on) {
  if (on && !porchLight) {
    porchLight = new THREE.PointLight(0xffb460, 26, 34, 2);
    porchLight.position.set(0, 5.4, 10);
    stage.add(porchLight);
  } else if (!on && porchLight) {
    stage.remove(porchLight);
    porchLight.dispose?.();
    porchLight = null;
  }
}

function resize() {
  const w = Math.max(1, viewport.clientWidth), h = Math.max(1, viewport.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

function fitCamera() {
  if (!current) return;
  const box = new THREE.Box3().setFromObject(current);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  controls.target.copy(c);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dir.lengthSq() < 1e-4) dir.set(0.8, 0.5, 1);
  dir.normalize();
  const dist = Math.max(s.length() * 1.22, 28);
  camera.position.copy(c).addScaledVector(dir, dist);
  camera.near = Math.max(0.1, dist / 200);
  camera.far = dist * 14;
  camera.updateProjectionMatrix();
  controls.update();
}

/* ------------------------------ spec → 几何 ------------------------------ */
function makeSpec(pass) {
  const P = params;
  const h = P.floors * 3.0;
  const M = name => material(name);
  const parts = [];
  const reps = [];

  /* 三角面预算决定 tessellation tier（optimization pass 才真正生效） */
  const tier = P.budget <= 6000 ? 4 : P.budget <= 20000 ? 12 : 24;
  const podium = new THREE.BoxGeometry(
    30, 1.2, 16,
    pass >= 8 ? tier : 2, 1, pass >= 8 ? Math.max(2, Math.round(tier * 0.7)) : 2
  );
  parts.push({ name: 'part_podium', role: 'base', geometry: podium,
               material: M('GY_base'), position: [0, -0.6, 0] });

  if (pass === 1) {
    parts.push({ name: 'part_block', role: 'body',
                 geometry: new THREE.BoxGeometry(24, h, 10),
                 material: M('GY_base'), position: [0, h / 2, 0] });
  } else {
    const wallGeo = new THREE.BoxGeometry(24, h, 10);
    const wallMat = pass >= 4 ? M('GY_wall') : M('GY_base');
    const roofMat = pass >= 4 ? M('GY_roof') : M('GY_base');
    parts.push({ name: 'part_wall', role: 'body', geometry: wallGeo,
                 material: wallMat, position: [0, h / 2, 0] });
    parts.push({ name: 'part_porch', role: 'porch',
                 geometry: new THREE.BoxGeometry(7.5, 3.4, 2.6),
                 material: roofMat, position: [0, 1.7, 6.2] });
    for (const [side, x] of [['l', -15], ['r', 15]]) {
      parts.push({ name: `part_wing_${side}`, role: 'wing',
                   geometry: new THREE.BoxGeometry(6, h * 0.62, 9),
                   material: wallMat, position: [x, h * 0.31, -0.5] });
    }
    parts.push({ name: 'part_slab', role: 'roof',
                 geometry: new THREE.BoxGeometry(25, 0.55, 11),
                 material: roofMat, position: [0, h + 0.28, 0] });

    if (pass >= 3) {
      parts.push({ name: 'part_parapet', role: 'parapet',
                   geometry: new THREE.BoxGeometry(25, 0.85, 0.6),
                   material: roofMat, position: [0, h + 0.95, 5.2] });
      parts.push({ name: 'part_parapet_back', role: 'parapet',
                   geometry: new THREE.BoxGeometry(25, 0.85, 0.6),
                   material: roofMat, position: [0, h + 0.95, -5.2] });
      parts.push({ name: 'part_cornice', role: 'trim',
                   geometry: new THREE.BoxGeometry(24.8, 0.35, 10.8),
                   material: pass >= 4 ? CORNICE_MAT : M('GY_base'),
                   position: [0, h - 0.35, 0] });
      parts.push({ name: 'part_roof_pitch', role: 'roof',
                   geometry: new THREE.BoxGeometry(25.4, 0.22, 11.4),
                   material: roofMat, position: [0, h + 0.72, 0],
                   rotation: [0, 0, P.pitch * 0.18] });
      parts.push({ name: 'part_step', role: 'base',
                   geometry: new THREE.BoxGeometry(32, 0.5, 18),
                   material: M('GY_base'), position: [0, -1.1, 0] });
    }
    if (pass >= 4) {
      parts.push({ name: 'part_edge', role: 'edge', line: true, renderOrder: 2,
                   geometry: new THREE.EdgesGeometry(wallGeo, 24),
                   material: M('GY_edge'), position: [0, h / 2, 0] });
    }
    if (pass >= 6) {
      parts.push({ name: 'part_lamp', role: 'lamp',
                   geometry: new THREE.BoxGeometry(1.4, 0.4, 0.9),
                   material: LAMP_MAT, position: [0, 3.9, 6.55] });
    }
    if (pass >= 7) {
      parts.push({ name: 'part_flag_pole', role: 'flag',
                   geometry: new THREE.CylinderGeometry(0.12, 0.12, 9, 8),
                   material: M('GY_base'), position: [0, h + 5.0, 0] });
      parts.push({ name: 'part_flag', role: 'flag',
                   geometry: new THREE.BoxGeometry(4.2, 2.4, 0.08),
                   material: FLAG_MAT, position: [2.1, h + 8.4, 0] });
    }
    if (pass >= 8) {
      const n = P.bays * 2;
      reps.push({
        name: 'rep_battlement', role: 'repetition', count: n,
        geometry: new THREE.BoxGeometry(1.1, 0.75, 0.55), material: M('GY_roof'),
        place: (i) => [-12 + (24 / Math.max(1, n - 1)) * i, h + 1.55, 5.2, 0, 1],
      });
      reps.push({
        name: 'rep_column', role: 'repetition', count: 4,
        geometry: new THREE.CylinderGeometry(0.28, 0.28, 3.4, 8), material: M('GY_base'),
        place: (i) => [-2.7 + i * 1.8, 1.7, 7.6, 0, 1],
      });
    }
  }

  const unlocked = DETAILS.filter(d => d.pass <= pass);
  const spec = {
    id: `gyirong_port_${pass}`, kind: 'building',
    parts, repetitions: reps,
    seed: 20260826,
    strict: $('c-strict').checked,
    qualityContract: {
      complexity: pass >= 4 ? 'compound' : 'simple',
      minComponents: Math.min(1 + pass, 8),
      minDetails: unlocked.length,
    },
    detailInventory: unlocked.map(d => ({
      id: d.id, mappedTo: d.mappedTo, confidence: d.confidence, note: d.note,
    })),
    confidence: CONFIDENCE,
    performanceBudget: { targetTriangles: P.budget, tier },
    passes: SCULPT_PASSES.slice(0, pass),
    reviewHistory: reviews.map(r => ({ pass: r.pass, verdict: r.verdict })),
    meta: { floors: P.floors, bays: P.bays, pitch: P.pitch, damage: P.damage, reference: 'inline-svg-composition' },
  };

  if (pass >= 7) {
    spec.anchor = 'anchor_porch_socket';
    spec.pivots = ['part_flag'];
    spec.destructionGroups = [{ name: 'facade', nodes: ['part_wall', 'part_parapet', 'part_edge'] }];
    spec.tick = (dt, elapsed, rt) => {
      const f = rt.nodes.find(n => n.name === 'part_flag');
      if (f) f.mesh.rotation.z = Math.sin(elapsed * 1.8) * 0.16;
    };
    spec.dispose = () => { disposeCount += 1; };
  }
  return spec;
}

/* ------------------------------ 门控 ------------------------------ */
function gateCheck(pass, spec, root) {
  const checks = [];
  const add = (name, ok, val) => checks.push({ name, ok, val });
  const rt = root.userData.sculptRuntime;
  const tri = triangleCount(root);
  add('组件树非空', spec.parts.length >= 2, `${spec.parts.length} parts`);
  let unnamed = 0;
  for (const p of spec.parts) {
    for (const m of (Array.isArray(p.material) ? p.material : [p.material])) {
      if (m && !m.name) unnamed += 1;
    }
  }
  add('材质全部命名', unnamed === 0, unnamed ? `${unnamed} 个未命名` : 'OK');
  const dangling = spec.detailInventory.filter(d => !d.mappedTo).length;
  add('身份细节全部映射', dangling === 0 && !injectedFault,
      injectedFault ? '注入了悬空细节' : `${dangling} 条悬空`);
  add('三角面在预算内', tri <= params.budget, `${tri} / ${params.budget}`);
  if (pass >= 7) {
    add('runtime 锚点 + 枢轴', rt.sockets.length > 0 && rt.pivots.length > 0,
        `${rt.sockets.length} sockets / ${rt.pivots.length} pivots`);
  }
  if (pass >= 8) {
    add('重复系统生效', rt.repetitions.length > 0, `${rt.repetitions.length} 组 InstancedMesh`);
  }
  return {
    pass: SCULPT_PASSES[pass - 1],
    verdict: checks.every(c => c.ok) ? 'pass' : 'fail',
    checks,
  };
}

/* ------------------------------ 构建 / 重建 ------------------------------ */
function build(pass, silent = false) {
  if (pass < 1 || pass > SCULPT_PASSES.length) return false;

  const spec = makeSpec(pass);
  preGate = validateSpec(spec, { strict: true });
  if (spec.strict && !preGate.ok) {
    if (!silent) {
      $('gate-test').textContent = 'strict-quality 拒绝生成：' + preGate.errors.join('；');
      renderGate();
    }
    return false;
  }

  let root;
  try {
    root = makeSculpt(spec);
  } catch (e) {
    if (!silent) $('gate-test').textContent = '构建被门控拦下：' + e.message;
    return false;
  }

  if (current) { disposeSculpt(current); current = null; }
  current = root;
  current.name = 'sculpt_gyirong_port';
  scene.add(current);

  /* 表面 / 灯光 / 损毁这些「运行期状态」由当前 pass 与参数共同决定 */
  winU.uWinOn.value = pass >= 5 && params.damage < 0.55 ? 1 : 0;
  winU.uFloors.value = params.floors * params.win;
  winU.uBays.value = params.bays * params.win;
  winU.uWinDamage.value = params.damage;
  winU.uNight.value = pass >= 6 ? params.night : 0;
  setStageLight(pass >= 6);
  if (params.damage > 0.01) applyDamage(current, params.damage);
  current.position.y = -params.damage * 0.9;
  current.rotation.z = params.damage * 0.02;

  fitCamera();
  passIndex = pass;

  lastGate = gateCheck(pass, spec, root);
  lastGateOk = lastGate.verdict === 'pass';
  const dup = reviews.findIndex(r => r.pass === lastGate.pass);
  if (dup >= 0) reviews[dup] = lastGate;
  else reviews.push(lastGate);
  reviews = reviews.slice(0, pass);      // 只保留当前链路的评审

  if (!silent) renderAll();
  return lastGateOk;
}

/* ------------------------------ UI ------------------------------ */
function renderPassList() {
  $('pass-list').innerHTML = SCULPT_PASSES.map((p, i) => {
    const n = i + 1;
    const cls = passIndex === n ? 'active'
              : passIndex > n ? 'done'
              : (lastGate && lastGate.pass === p && lastGate.verdict === 'fail') ? 'fail' : '';
    return `<div class="pass ${cls}" data-pass="${n}">
      <span class="idx">${n}</span><span class="cn">${PASS_CN[p]}</span><span class="en">${p}</span>
    </div>`;
  }).join('');
  for (const el of $('pass-list').querySelectorAll('.pass')) {
    el.onclick = () => { build(Number(el.dataset.pass)); renderAll(); };
  }
  $('btn-next').disabled = !lastGateOk || passIndex >= SCULPT_PASSES.length;
  $('btn-next').textContent = passIndex >= SCULPT_PASSES.length ? '已完成 8 / 8'
                            : !lastGateOk ? '门控未通过（已锁定）' : '下一阶段';
}

function renderGate() {
  const rows = (lastGate?.checks || []).map(c =>
    `<div class="gate-row"><span class="dot ${c.ok ? 'ok' : 'bad'}"></span>
      <span class="gname">${c.name}</span><span class="gval">${c.val}</span></div>`
  ).join('');
  const pre = preGate
    ? `<div class="gate-row"><span class="dot ${preGate.ok ? 'ok' : 'bad'}"></span>
        <span class="gname">strict-quality（生成前）</span>
        <span class="gval">${preGate.ok ? 'PASS' : preGate.errors.length + ' 错误'}</span></div>`
    : '';
  const warn = preGate?.warnings?.length
    ? `<p class="note">门控警告：${preGate.warnings.join('；')}</p>` : '';
  $('gate').innerHTML = `<b>当前阶段门控</b>${pre}${rows}${warn}`;
}

function renderDetails() {
  $('detail-list').innerHTML = DETAILS.map(d => {
    const on = d.pass <= passIndex;
    return `<div class="detail ${on ? '' : 'pending'}">
      <span class="num">${d.num}</span>
      <div class="body"><b>${d.id}</b><span>${on ? '→ ' + d.mappedTo + ' · ' + d.note : '未解锁（第 ' + d.pass + ' 阶段）'}</span></div>
      <span class="cf">${on ? d.confidence.toFixed(2) : '—'}</span>
    </div>`;
  }).join('');
}

function renderMetrics() {
  const rt = current?.userData.sculptRuntime;
  const tri = current ? triangleCount(current) : 0;
  const cells = [
    [tri.toLocaleString(), '三角面 / 预算 ' + params.budget.toLocaleString()],
    [rt ? rt.nodes.length + rt.repetitions.reduce((a, r) => a + r.count, 0) : 0, '组件与实例'],
    [rt ? rt.materials.length : 0, '命名材质'],
    [`${passIndex} / 8`, '已解锁 pass'],
  ];
  $('metrics').innerHTML = cells.map(([v, l]) =>
    `<div class="metric"><div class="v">${v}</div><div class="l">${l}</div></div>`
  ).join('');
}

function renderSpec() {
  if (!current) { $('spec-json').textContent = '等待构建…'; return; }
  $('spec-json').textContent = JSON.stringify(snapshotSpec(current), null, 2);
}

function renderReviews() {
  $('reviews').innerHTML = reviews.length ? reviews.map(r =>
    `<div class="rev"><span class="pill ${r.verdict}">${r.verdict.toUpperCase()}</span>
      <span class="txt">${r.pass} · ${r.checks.filter(c => c.ok).length}/${r.checks.length} 项通过</span></div>`
  ).join('') : '<p class="note">尚无评审记录，点「下一阶段」开始。</p>';
}

function renderAll() {
  /* 单个文案节点缺失不应中断整条渲染链（这里踩过一次：vp-tip 漏写 id） */
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  setText('vp-title', passIndex
    ? `${PASS_CN[SCULPT_PASSES[passIndex - 1]]} · ${SCULPT_PASSES[passIndex - 1]}`
    : '等待构建');
  setText('vp-pass', `${passIndex} / 8`);
  setText('vp-tip', `Three.js r160 · 代码生成几何，无 mesh / 贴图文件 · dispose 调用 ${disposeCount} 次`);
  renderPassList(); renderGate(); renderDetails();
  renderMetrics(); renderSpec(); renderReviews();
}

/* 运行时诊断：与沙盘 window.__dbg() 同风格，供自动化回归直接读 GPU 实测值 */
window.__lab = () => ({
  ready: !!current,
  pass: passIndex,
  passName: passIndex ? SCULPT_PASSES[passIndex - 1] : null,
  drawCalls: renderer.info.render.calls,
  gpuTriangles: renderer.info.render.triangles,   // WebGL 实际绘制，不是 spec 估算
  specTriangles: current ? triangleCount(current) : 0,
  gateOk: lastGateOk,
  reviews: reviews.map(r => ({ pass: r.pass, verdict: r.verdict })),
  disposeCount, injectedFault,
  shaderOn: winU.uWinOn.value,
  camera: camera.position.toArray().map(v => +v.toFixed(1)),
});

/* ------------------------------ 交互 ------------------------------ */
$('btn-next').onclick = () => { if (lastGateOk && passIndex < 8) { build(passIndex + 1); renderAll(); } };
$('btn-all').onclick = () => {
  reviews = [];
  for (let p = 1; p <= 8; p++) {
    const ok = build(p, true);
    if (!ok) break;
  }
  renderAll();
};
$('btn-reset').onclick = () => {
  if (current) { disposeSculpt(current); current = null; }
  passIndex = 0; reviews = []; lastGate = null; lastGateOk = true; preGate = null;
  setStageLight(false);
  winU.uWinOn.value = 0;
  renderAll();
};
$('btn-gate-test').onclick = () => {
  injectedFault = !injectedFault;
  const badSpec = {
    id: 'fault_demo', parts: [{ name: 'part_a' }],
    detailInventory: [{ id: 'D7 悬空细节', confidence: 0.9 }],
    qualityContract: { minComponents: 1, minDetails: 1 },
  };
  const r = validateSpec(badSpec, { strict: true });
  $('btn-gate-test').textContent = injectedFault ? '恢复 spec（解除缺陷）' : '故意破坏 spec，看门控';
  $('gate-test').textContent = injectedFault
    ? `门控拦下：「${r.errors[0]}」。下一阶段已锁定；再点一次恢复。`
    : '门控恢复：所有细节都已映射。';
  if (passIndex > 0) { build(passIndex, true); }
  renderAll();
};

const bind = (sid, vid, key, fmt = v => v) => {
  const el = $(sid);
  el.oninput = () => {
    params[key] = Number(el.value);
    $(vid).textContent = fmt(params[key]);
    if (passIndex > 0) build(passIndex);
    renderAll();
  };
};
bind('s-floors', 'v-floors', 'floors', v => v);
bind('s-bays', 'v-bays', 'bays', v => v);
bind('s-pitch', 'v-pitch', 'pitch', v => v.toFixed(2));
bind('s-win', 'v-win', 'win', v => v.toFixed(2));
bind('s-damage', 'v-damage', 'damage', v => v.toFixed(2));
bind('s-night', 'v-night', 'night', v => v.toFixed(2));
bind('s-budget', 'v-budget', 'budget', v => v.toLocaleString());
$('c-strict').onchange = () => { if (passIndex > 0) { build(passIndex); } renderAll(); };
$('c-compare').onchange = e => $('side-by-side').classList.toggle('on', e.target.checked);

/* ------------------------------ 渲染循环 ------------------------------ */
let prev = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;
  if (current) {
    if ($('c-spin').checked) current.rotation.y += dt * 0.18;
    if (current.userData.tick) current.userData.tick(dt, now / 1000);
  }
  controls.update();
  renderer.render(scene, camera);
}

/* 首屏直接给出第 1 阶段，避免空视口 */
build(1);
renderAll();
requestAnimationFrame(loop);
