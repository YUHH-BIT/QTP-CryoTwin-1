/* ==========================================================================
   proc.js — 可复用的程序化建模骨架（演示级）

   沿用学习材料里那套「快速建模」方法，把散落的手写盒子收敛成一条工厂流水线：

   ① img2threejs：一张参考图 → AI 分析结构 → 输出**可编辑的 THREE.Group 代码**
      而不是黑盒网格。它给每个产物挂 userData.sculptRuntime（nodes / sockets /
      colliders / destruction groups）和一份 ObjectSculptSpec JSON。
      这里沿用它的**输出契约**：makeSculpt(spec) 返回带 sculptRuntime 的 Group，
      几何、材质、锚点都由一份 JSON spec 描述，改一句话就能改一类资产。

   ⑤ 医院数字孪生：材质用命名约定（TJ_glass / warmGlass / floorEdge）对应色板，
      切换昼夜时遍历材质改色，命名规范代替 if-else；锚点缺失直接 throw 而非 warning；
      模型自带身份 userData，别用屏幕坐标猜。这里沿用 PALETTE + material(name)
      + assertAnchors() + 每栋建筑的 anchor_ 空物体。

   ② 防汛沙盘：黏土质感、墒情热力、龟裂纹理全写在片元着色器里，用 uniform 开关控制，
      「用着色器画地形，而不是贴图」。这里沿用 attachBank()/attachFacade()：
      岸边湿边、泡沫带、砾石滩、河面流纹和建筑窗格都是 GLSL 程序化生成，
      不新增几何体、不额外下载贴图。

   ④ GPU 高度场：水深控制颜色/透明度/反光，流向驱动水面动态箭头。
      这里沿用其「流纹 + 流向箭头」的片元表达（见 app.js HAZARD_FRAG）。

   新增一类资产只需写一份 spec，例如桥梁、监测站、庄台：
     makeSculpt({ id:'bridge_01', kind:'bridge', parts:[...], anchor:'anchor_bridge_01' })
   本文件已被 OSM 建筑与源区冰岩块两处复用；diagnose() 可核对产物数量。

   2026-11-07 补：按 img2threejs 2.0.1 的**产物契约**再对齐一层（见文件末
   「输出契约 v2」一节）：spec 门控 / detailInventory / confidence / 性能预算 /
   repetition systems / pivots / destructionGroups / tick / dispose / snapshotSpec。
   全部为可选字段，旧调用（OSM 建筑、冰岩块）行为不变。
   ========================================================================== */

import * as THREE from './lib/three.module.js?v=20261111a';

/* ---------------------- 材质色板：命名约定代替 if-else ---------------------- */
export const PALETTE = {
  GY_wall:    { color: 0xf3ede1, roughness: 0.88, metalness: 0.0 },
  GY_roof:    { color: 0x9a8b76, roughness: 0.94, metalness: 0.0 },
  GY_base:    { color: 0xb9ab96, roughness: 0.96, metalness: 0.0 },
  GY_window:  { color: 0x4c6b82, roughness: 0.30, metalness: 0.10 },
  GY_edge:    { color: 0x2b3b45, opacity: 0.85 },
  GY_damage:  { color: 0x5b5044, roughness: 0.97, metalness: 0.0 },
  // 冰体要在一片雪白的地表上「认得出来」：旧值 0xe4f1fb 与雪原同色，22 km 全景里
  // 完全融进背景。压到偏青的冰蓝、抬一点自发光，靠色相而不是亮度区分（2026-11-12）。
    // 冰体：在雪原/岩壁背景上要「一眼读成冰」而非一块白。旧值近白 + 自发光 0.5，
  // 近距离直接过曝成纯白球（实测 600 m 处占满画面、没有一点冰的质感）。
  // 改成饱和冰蓝 + 低自发光 + 较高粗糙度，靠色相而不是亮度区分。
  GY_ice:     { color: 0x4f9fc8, roughness: 0.45, metalness: 0.05,
                emissive: 0x0d3a52, emissiveIntensity: 0.18, flatShading: true },
};

const matCache = new Map();
export function material(name) {
  if (!PALETTE[name]) throw new Error(`材质未在色板注册：${name}`);
  if (matCache.has(name)) return matCache.get(name);
  const p = PALETTE[name];
  const m = name === 'GY_edge'
    ? new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: p.opacity })
    : new THREE.MeshStandardMaterial({
        color: p.color, roughness: p.roughness, metalness: p.metalness,
        emissive: p.emissive ?? 0x000000,
        emissiveIntensity: p.emissiveIntensity ?? 0,
        flatShading: p.flatShading ?? false,
        side: THREE.DoubleSide,
      });
  m.name = name;                       // 名字即身份，遍历时不用猜
  matCache.set(name, m);
  return m;
}
export const paletteNames = () => Object.keys(PALETTE);

/* ---------------------- 工厂：spec → 可编辑 THREE.Group ---------------------- */
const registry = new Map();

/**
 * spec = {
 *   id, kind,
 *   parts: [{ name, role, geometry, material, line? }],  // material 可为数组（ExtrudeGeometry 的 cap/side 分组）
 *   anchor?: string,     // 额外挂一个空物体做锚点（医院孪生那条经验）
 *   meta?: object        // 业务属性写这里，不散落在 mesh 上
 * }
 */
export function makeSculpt(spec) {
  if (!spec || !spec.id || !Array.isArray(spec.parts)) {
    throw new Error('makeSculpt: spec 必须含 id 与 parts[]');
  }
  if (spec.strict) assertSpec(spec);       // fail-closed：门控不过，一行几何都不写
  const root = new THREE.Group();
  root.name = `sculpt_${spec.id}`;

  const rt = {
    specVersion: 2,             // ① 的 ObjectSculptSpec 风格：可序列化、可 diff
    id: spec.id, kind: spec.kind,
    nodes: [], sockets: [], materials: [], colliders: [],
    pivots: [], repetitions: [],
    destructionGroups: (spec.destructionGroups || []).map(g => ({ ...g })),
    qualityContract: spec.qualityContract || null,
    detailInventory: (spec.detailInventory || []).map(d => ({ ...d })),
    confidence: spec.confidence || null,
    performanceBudget: spec.performanceBudget || null,
    seed: spec.seed ?? 20260826,
    passes: [...(spec.passes || [])],
    reviewHistory: [...(spec.reviewHistory || [])],
    meta: spec.meta || {},
  };
  root.userData.sculptRuntime = rt;
  Object.assign(root.userData, rt.meta);   // 业务字段也能直接 root.userData.hh 取

  for (const p of spec.parts) {
    const obj = p.line
      ? new THREE.LineSegments(p.geometry, p.material)
      : new THREE.Mesh(p.geometry, p.material);
    obj.name = p.name;
    obj.userData.role = p.role || 'body';
    if (p.renderOrder !== undefined) obj.renderOrder = p.renderOrder;
    if (p.position) obj.position.set(...p.position);
    if (p.scale) obj.scale.set(...p.scale);
    if (p.rotation) obj.rotation.set(...p.rotation);
    if (p.visible === false) obj.visible = false;
    root.add(obj);

    const mats = Array.isArray(p.material) ? p.material : [p.material];
    for (const m of mats) {
      if (m && m.name && !rt.materials.includes(m.name)) rt.materials.push(m.name);
    }
    rt.nodes.push({ name: p.name, role: obj.userData.role, mesh: obj,
                    base: p.material, line: !!p.line });
    if (obj.userData.role === 'body') rt.colliders.push(p.name);
  }

  if (spec.anchor) {
    const a = new THREE.Object3D();
    a.name = spec.anchor;
    root.add(a);
    rt.sockets.push(spec.anchor);
  }

  /* 重复系统：窗格、立柱、栏杆这类「决定身份的细节」用 InstancedMesh 表达，
     改一处 spec 参数整组跟着变，而不是散落几百个手写 mesh。             */
  const rnd = seededRandom(rt.seed);
  for (const r of spec.repetitions || []) {
    const n = Math.max(0, Math.floor(r.count || 0));
    if (!n || !r.geometry) continue;
    const inst = new THREE.InstancedMesh(r.geometry, r.material, n);
    inst.name = r.name;
    inst.userData.role = r.role || 'repetition';
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
          e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const v = r.place ? r.place(i, rnd) : [0, 0, 0];
      p.set(v[0], v[1], v[2]);
      e.set(0, v[3] || 0, 0); q.setFromEuler(e);
      s.setScalar(v[4] ?? 1);
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    root.add(inst);
    rt.repetitions.push({ name: r.name, count: n, role: inst.userData.role });
    if (r.material?.name && !rt.materials.includes(r.material.name)) {
      rt.materials.push(r.material.name);
    }
  }

  /* pivots：把节点包进可独立旋转的空 Group，位置变换与旋转变换分离 */
  for (const name of spec.pivots || []) {
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`makeSculpt: pivot 指向不存在的节点 ${name}`);
    const pivot = new THREE.Group();
    pivot.name = `pivot_${name}`;
    node.parent.add(pivot);
    pivot.add(node);
    rt.pivots.push({ name, wrapper: pivot.name, node });
  }

  /* 运行时生命周期：img2threejs 的 root.userData.tick / dispose 契约 */
  if (spec.tick) root.userData.tick = (dt, elapsed) => spec.tick(dt, elapsed, rt);
  if (spec.dispose) root.userData.dispose = () => spec.dispose(rt);
  rt.triangles = triangleCount(root);

  registry.set(spec.id, root);
  return root;
}

/** 锚点缺失直接抛错：早失败比晚失败便宜（医院孪生踩过的坑） */
export function assertAnchors(root, ids) {
  for (const id of ids) {
    if (!root.getObjectByName(id)) throw new Error(`模型锚点缺失：${id}`);
  }
}

/** 损毁按命名约定整组切材质，而不是逐个 mesh 写 if-else */
export function applyDamage(root, k) {
  const rt = root.userData.sculptRuntime;
  if (!rt) return;
  const dark = k > 0.55;
  for (const n of rt.nodes) {
    if (n.role === 'edge') continue;          // 轮廓线保持，勾出损毁后的形体
    const target = dark ? material('GY_damage') : n.base;
    if (n.mesh.material !== target) n.mesh.material = target;
  }
}

export function diagnose() {
  let nodes = 0;
  const kinds = {};
  for (const g of registry.values()) {
    nodes += g.userData.sculptRuntime.nodes.length;
    const k = g.userData.sculptRuntime.kind;
    kinds[k] = (kinds[k] || 0) + 1;
  }
  return { sculpts: registry.size, nodes, kinds, palette: paletteNames() };
}

/* ---------------------- 着色器补丁：程序化立面 ----------------------
   ExtrudeGeometry 侧面 UV 的 v = 1 - z，即沿挤出高度 0..1；u 是沿轮廓的世界米数。
   用它画楼层线、窗格、基座暗带，完全不新增几何体、不需要贴图文件。         */
export function attachFacade(mat, uniforms) {
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec2 vFacadeUv;\n' + shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\n  vFacadeUv = uv;'
    );
    shader.fragmentShader = `
varying vec2 vFacadeUv;
uniform float uFacadeOn;
uniform float uFacadeDamage;
float gyHash(vec2 p) { return fract(sin(dot(p, vec2(41.31, 289.17))) * 43758.5453); }
` + shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
  if (uFacadeOn > 0.5 && uFacadeDamage < 0.5) {
    // 楼层带：v 沿高度 0..1，按 3.2 m 一层折算成 4~9 层
    float floors = clamp(floor(vFacadeUv.y * 6.0 + 1.0), 2.0, 9.0);
    float fv = fract(vFacadeUv.y * floors);
    float band = smoothstep(0.14, 0.24, fv) * (1.0 - smoothstep(0.70, 0.80, fv));
    // 窗格：u 是世界米，按 3.6 m 一格
    float fu = fract(vFacadeUv.x / 3.6);
    float win = band * smoothstep(0.16, 0.26, fu) * (1.0 - smoothstep(0.74, 0.84, fu));
    vec3 glass = mix(vec3(0.16, 0.28, 0.38), vec3(0.42, 0.60, 0.72),
                     gyHash(floor(vec2(vFacadeUv.x / 3.6, vFacadeUv.y * floors))));
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.78);
    // 层间线与基座暗带
    float slab = 1.0 - smoothstep(0.0, 0.055, fv);
    diffuseColor.rgb *= 1.0 - slab * 0.28;
    diffuseColor.rgb *= 1.0 - (1.0 - smoothstep(0.0, 0.06, vFacadeUv.y)) * 0.30;
  }`
    );
  };
  mat.customProgramCacheKey = () => 'gy-facade-v1';
  return mat;
}

/* ---------------------- 着色器补丁：程序化岸边 ----------------------
   输入 uBank 是一张到沟道中心的最短距离纹理（0 = 沟心，1 = >900 m）。
   在卫星影像之上按距离依次合成：河面流纹 → 湿边泡沫 → 砾石滩 → 植被色带。
   对应学习材料 ② 的「着色器画地形」与 ④ 的「水深控色/反光」。         */
export function attachBank(mat, uniforms) {
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec2 vBankUv;\n' + shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\n  vBankUv = uv;'
    );
    shader.fragmentShader = `
varying vec2 vBankUv;
uniform sampler2D uBank;
uniform float uBankOn;
uniform float uBankTime;
float gyBankHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
` + shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
  if (uBankOn > 0.5) {
    float d = texture2D(uBank, vBankUv).r;      // 0..1 ≈ 0..900 m
    // 常水位河面：青蓝水色 + 随时间的流纹反光
    float water = 1.0 - smoothstep(0.026, 0.052, d);
    float rip = 0.5 + 0.5 * sin(vBankUv.x * 430.0 - uBankTime * 1.7
                                + sin(vBankUv.y * 270.0) * 2.2);
    vec3 waterCol = mix(vec3(0.07, 0.22, 0.34), vec3(0.24, 0.46, 0.58), rip * 0.55);
    diffuseColor.rgb = mix(diffuseColor.rgb, waterCol, water * 0.80);
    // 岸线湿边与泡沫带：窄而亮，作为水/陆之间的清晰分界
    float foam = (1.0 - smoothstep(0.044, 0.066, d)) * smoothstep(0.028, 0.044, d);
    float foamN = 0.62 + 0.38 * gyBankHash(floor(vBankUv * 1500.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.97, 0.99), foam * foamN * 0.90);
    // 砾石滩：窄带 + 细颗粒噪声，不做真实粒径；铺太宽会像一条水泥路
    float gravel = (1.0 - smoothstep(0.095, 0.155, d)) * smoothstep(0.052, 0.072, d);
    float g = gyBankHash(floor(vBankUv * 2300.0));
    vec3 gravelCol = mix(vec3(0.52, 0.49, 0.44), vec3(0.78, 0.74, 0.65), g);
    diffuseColor.rgb = mix(diffuseColor.rgb, gravelCol, gravel * 0.30);
    // 河岸植被色带：轻微增绿
    float veg = (1.0 - smoothstep(0.26, 0.36, d)) * smoothstep(0.16, 0.22, d);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.82, 1.10, 0.80), veg * 0.45);
    // 流向箭头：沿沟道方向的周期性 V 形亮纹（④ 的表达方式，只示意方向不代表流速）
    float ar = fract(vBankUv.y * 62.0 - uBankTime * 0.35);
    float chevron = smoothstep(0.44, 0.50, ar) * (1.0 - smoothstep(0.50, 0.57, ar));
    diffuseColor.rgb += vec3(0.28, 0.34, 0.36) * chevron * water * 0.55;
  }`
    );
  };
  mat.customProgramCacheKey = () => 'gy-bank-v1';
  return mat;
}

/* ---------------------- 程序化距离场：到真实沟道的最短距离 ----------------------
   CPU 上用 splatting 近似（O(沟道点数 × 局部窗口)），一次生成、作为 uniform 传入。
   纹理行 0 = 南(z=+sz/2)、行 H-1 = 北(z=-sz/2)，与地形 uv.y = 1 - r/(gy-1) 对齐。 */
export function buildDistanceField(chanPts, sx, sz, W = 768, H = 432, radius = 900) {
  const dist = new Float32Array(W * H).fill(1e9);
  const cw = sx / (W - 1), ch = sz / (H - 1);
  const ri = radius / cw, rj = radius / ch;
  for (const p of chanPts) {
    const ci = (p.x + sx / 2) / cw, cj = (sz / 2 - p.z) / ch;
    const i0 = Math.max(0, Math.floor(ci - ri)), i1 = Math.min(W - 1, Math.ceil(ci + ri));
    const j0 = Math.max(0, Math.floor(cj - rj)), j1 = Math.min(H - 1, Math.ceil(cj + rj));
    for (let j = j0; j <= j1; j++) {
      const z = sz / 2 - j * ch, dz = z - p.z;
      for (let i = i0; i <= i1; i++) {
        const x = -sx / 2 + i * cw, dx = x - p.x;
        const d2 = dx * dx + dz * dz;
        const k = j * W + i;
        if (d2 < dist[k]) dist[k] = d2;
      }
    }
  }
  const bytes = new Uint8Array(W * H);
  for (let k = 0; k < dist.length; k++) {
    const d = Math.sqrt(dist[k]);
    bytes[k] = d >= radius ? 255 : Math.round(d / radius * 255);
  }
  const tex = new THREE.DataTexture(bytes, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { texture: tex, width: W, height: H, radius };
}

/* ==========================================================================
   输出契约 v2 —— 按 img2threejs 2.0.1 对齐（2026-11-07）

   核对结论（重要，别把宣传口径当成实际代码）：
   · README / docs/ARCHITECTURE.md 宣称产物是
       createObjectNameModel(spec, options) + ObjectSculptSpec JSON
       + root.userData.sculptRuntime{nodes, sockets, colliders, destructionGroups}。
   · 但画廊里真实落地的生成代码（showcase/src/demos/tropical-island/
       createTropicalIslandModel.ts）是**无参工厂** createTropicalIslandModel(): THREE.Group，
       没有 sculptRuntime；参数以源码常量 PALETTE / PROP_SLOTS / PATH_SAMPLES 暴露，
       运行时句柄放在 root.userData.tick / dispose / ocean / waveBodies 上。
   · 所以这里沿用「契约精神」而不是照抄某个函数签名：结构由 spec 描述、产物可 diff、
     可编辑、带生命周期；同时把两种暴露方式都保留。

   真正值得沿用的 6 条（成本最低、收益最大）：
   ① 分 pass 构建：blockout → structural → form → material → surface
                  → lighting → interaction → optimization，一次只改一层。
   ② detailInventory 先行：先列出决定身份的细节（女儿墙、檐带、窗格、基座、
      接缝、光泽/哑光分区），每条必须 mappedTo 真实组件或命名材质，
      否则门控拒绝生成 —— 防止「一张贴图冒充结构」。
   ③ 确定性种子：所有程序化噪声/随机摆放必须可复现，便于 diff 与回归。
   ④ 几何门控在渲染之前：Box3 归一化、附着锚点、三角面预算先查，
      不要靠一张正面截图判断模型没穿帮。
   ⑤ scripts enforce / model judges：确定性校验交给代码，只有「像不像」才需要人看；
      一次评审只看一张 side-by-side 对照图。
   ⑥ 诚实边界：单图看不到背面，按区域标 confidence，允许输出「只能做到示意」。
   ========================================================================== */

/** 固定构建顺序：一个 pass 通过了才解锁下一个 */
export const SCULPT_PASSES = [
  'blockout', 'structural', 'form', 'material',
  'surface', 'lighting', 'interaction', 'optimization',
];

/** mulberry32：同一个 seed 永远得到同一批程序化摆放/噪声 */
export function seededRandom(seed = 20260826) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * strict-quality 门控的轻量版：在写几何之前挡住「空壳 spec」。
 * 返回 { ok, errors, warnings }；assertSpec 为 fail-closed 版本。
 */
export function validateSpec(spec, { strict = true } = {}) {
  const errors = [], warnings = [];
  if (!spec || !spec.id) errors.push('缺少 id');
  if (!spec || !Array.isArray(spec.parts) || !spec.parts.length) {
    errors.push('parts[] 为空：不允许单根节点的空壳模型');
  }
  if (!strict) return { ok: errors.length === 0, errors, warnings };

  const names = new Set((spec.parts || []).map(p => p.name));
  for (const r of spec.repetitions || []) names.add(r.name);
  const mats = new Set(paletteNames());
  for (const d of spec.detailInventory || []) {
    if (!d.id) { errors.push('detailInventory 条目缺 id'); continue; }
    if (!d.mappedTo) {
      errors.push(`细节「${d.id}」未 mappedTo 真实组件/材质（禁止用贴图冒充结构）`);
      continue;
    }
    if (!names.has(d.mappedTo) && !mats.has(d.mappedTo)) {
      errors.push(`细节「${d.id}」映射到不存在的 ${d.mappedTo}`);
    }
    if (d.confidence !== undefined && !(d.confidence >= 0 && d.confidence <= 1)) {
      errors.push(`细节「${d.id}」confidence 越界`);
    }
  }
  const qc = spec.qualityContract;
  if (qc) {
    const total = (spec.parts || []).length + (spec.repetitions || []).length;
    if (total < (qc.minComponents || 0)) {
      errors.push(`组件数 ${total} 低于 qualityContract.minComponents ${qc.minComponents}`);
    }
    if ((spec.detailInventory || []).length < (qc.minDetails || 0)) {
      errors.push(`detailInventory 只有 ${(spec.detailInventory || []).length} 条，低于 ${qc.minDetails}`);
    }
  }
  if (spec.confidence?.overall !== undefined &&
      !(spec.confidence.overall >= 0 && spec.confidence.overall <= 1)) {
    errors.push('confidence.overall 越界');
  }
  if (spec.reviewHistory?.length) {
    for (const r of spec.reviewHistory) {
      if (!r.pass || !['pass', 'fail'].includes(r.verdict)) {
        errors.push(`reviewHistory 条目不合法：${JSON.stringify(r)}`);
      }
    }
  }
  if (!spec.confidence) warnings.push('未标注 confidence：单图看不到的背面应记为低置信');
  if (!spec.performanceBudget) warnings.push('未设 performanceBudget：无法按三角面预算降分段');
  return { ok: errors.length === 0, errors, warnings };
}

export function assertSpec(spec) {
  const r = validateSpec(spec, { strict: true });
  if (!r.ok) throw new Error('strict-quality 门控未通过：\n  - ' + r.errors.join('\n  - '));
  return r;
}

/** Box3 归一化：按目标高度缩放并居中落地（showcase 的 normaliseToHeight 思路） */
export function fitToBox(root, targetHeight, yaw = 0) {
  root.rotation.y += yaw;
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  root.scale.multiplyScalar(targetHeight / Math.max(size.y, 1e-3));
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x;
  root.position.y -= box.min.y;
  root.position.z -= c.z;
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
}

/** 只数真正的三角面；线框轮廓与 InstancedMesh 都要正确处理 */
export function triangleCount(root) {
  let n = 0;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const t = g.index ? g.index.count / 3
                      : (g.attributes.position ? g.attributes.position.count / 3 : 0);
    n += t * (o.isInstancedMesh ? o.count : 1);
  });
  return Math.round(n);
}

/** 导出可 diff / 可 JSON 化的 spec（不含 mesh 引用），等价于 ObjectSculptSpec 快照 */
export function snapshotSpec(root) {
  const rt = root?.userData?.sculptRuntime;
  if (!rt) throw new Error('snapshotSpec: 不是 makeSculpt 产物');
  return {
    specVersion: rt.specVersion, id: rt.id, kind: rt.kind, seed: rt.seed,
    triangles: triangleCount(root),
    qualityContract: rt.qualityContract, performanceBudget: rt.performanceBudget,
    confidence: rt.confidence,
    detailInventory: rt.detailInventory.map(d => ({ ...d })),
    nodes: rt.nodes.map(n => ({
      name: n.name, role: n.role, line: n.line,
      materials: (Array.isArray(n.base) ? n.base : [n.base]).filter(Boolean).map(m => m.name),
    })),
    materials: [...rt.materials], sockets: [...rt.sockets],
    pivots: rt.pivots.map(p => ({ name: p.name, wrapper: p.wrapper })),
    colliders: [...rt.colliders],
    destructionGroups: rt.destructionGroups.map(g => ({ ...g, nodes: [...(g.nodes || [])] })),
    repetitions: rt.repetitions.map(r => ({ ...r })),
    passes: [...rt.passes],
    reviewHistory: rt.reviewHistory.map(r => ({ ...r })),
    meta: { ...rt.meta },
  };
}

/** 反复重建时清理：只 dispose 每份 spec 自建的 geometry，命名材质走缓存不销毁 */
export function disposeSculpt(root) {
  if (!root) return;
  const rt = root.userData.sculptRuntime;
  if (typeof root.userData.dispose === 'function') {
    try { root.userData.dispose(); } catch (_) { /* 清理失败不阻断 */ }
  }
  const geos = new Set();
  root.traverse(o => { if (o.geometry) geos.add(o.geometry); });
  geos.forEach(g => g.dispose());
  if (rt) registry.delete(rt.id);
  if (root.parent) root.parent.remove(root);
}

/* ---------------------- 着色器补丁：通用立面窗格 ----------------------
   与 attachFacade 的区别：attachFacade 依赖 ExtrudeGeometry 的侧面 UV；
   这里用局部坐标 + 法线，BoxGeometry / ExtrudeGeometry 都能用，
   且四向立面自动切换投影轴，顶/底面不画窗。                         */
export function attachWindowGrid(mat, uniforms) {
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vGyLocal;\nvarying vec3 vGyNormal;\n'
      + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vGyLocal = position;\n  vGyNormal = normal;'
      );
    shader.fragmentShader = `
varying vec3 vGyLocal;
varying vec3 vGyNormal;
uniform float uWinOn;
uniform float uFloors;
uniform float uBays;
uniform float uWinDamage;
uniform float uNight;
float gyWinHash(vec2 p) { return fract(sin(dot(p, vec2(41.31, 289.17))) * 43758.5453); }
` + shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
  if (uWinOn > 0.5 && uWinDamage < 0.5 && abs(vGyNormal.y) < 0.5) {
    vec2 p = abs(vGyNormal.x) > 0.5 ? vGyLocal.zy : vGyLocal.xy;
    vec2 cell = vec2(p.x * uBays / 24.0, p.y * uFloors / 12.0) + 0.5;
    vec2 f = fract(cell);
    float win = smoothstep(0.18, 0.27, f.x) * (1.0 - smoothstep(0.73, 0.82, f.x))
              * smoothstep(0.20, 0.29, f.y) * (1.0 - smoothstep(0.71, 0.80, f.y));
    float lit = step(0.62, gyWinHash(floor(cell)));
    vec3 glass = mix(vec3(0.10, 0.19, 0.26), vec3(0.98, 0.74, 0.40), lit * uNight);
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.88);
    float mullion = (1.0 - smoothstep(0.0, 0.035, f.x))
                  + (1.0 - smoothstep(0.0, 0.035, f.y));
    diffuseColor.rgb *= 1.0 - min(mullion, 1.0) * win * 0.18;
  }`
    );
  };
  mat.customProgramCacheKey = () => 'gy-windowgrid-v1';
  return mat;
}
