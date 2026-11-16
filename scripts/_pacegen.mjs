// 生成 app.js 的 PACE_TABLE（后段播放节奏补偿表）
// 原理：沿沟道中轴从 arrival.bin 抽到达时间 T(s)，反查 S(tField)，
//       量出「每 0.05 ratio 推进多少里程」，把后段（明显偏慢的那两段）按
//       PACE = 0.85 × 前段平均推进 / 本段推进 补偿到前段的 85%。
// 用法: node scripts/_pacegen.mjs [目标比例=0.85] [clamp上限=5.0]
// 输出：可直接粘贴进 app.js 的 PACE_TABLE、以及改前/改后的分段视觉速度。
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('webgis_frontend/terrain3d/demo/data');
const j = n => JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8'));
const fld = j('field.json'), ch = j('channel.json');
const T_FIELD = 470;                       // flood.js：演示比例 1.0 对应的场时间
const TARGET = Number(process.argv[2] || 0.85);
const CAP = Number(process.argv[3] || 5.0);

const SW = fld.nx, SH = fld.ny, SC = fld.arrivalScale, bb = fld.bbox;
const u8 = new Uint8Array(fs.readFileSync(path.join(DATA, 'arrival.bin')));
const samp = (lon, lat) => {
  const u = (lon - bb[0]) / (bb[2] - bb[0]);
  const v = (bb[3] - lat) / (bb[3] - bb[1]);           // 行 0 = 北
  const i = Math.max(0, Math.min(SW - 1, Math.round(u * SW - 0.5)));
  const k = Math.max(0, Math.min(SH - 1, Math.round(v * SH - 0.5)));
  return u8[k * SW + i] * SC;
};

// 与 flood.js bakeSource 同口径：包络外的「永不」值先插值补，再沿程单调化
const T_BAD = fld.tMax - 12;
const rows = ch.points.map(p => ({ s: p[3], T: samp(p[0], p[1]) }))
  .map(r => ({ s: r.s, T: r.T >= T_BAD ? NaN : r.T }));
for (let k = 0; k < rows.length; k++) {
  if (!Number.isNaN(rows[k].T)) continue;
  let a = k - 1; while (a >= 0 && Number.isNaN(rows[a].T)) a--;
  let b = k + 1; while (b < rows.length && Number.isNaN(rows[b].T)) b++;
  const va = a >= 0 ? rows[a].T : (b < rows.length ? rows[b].T : 0);
  const vb = b < rows.length ? rows[b].T : va;
  rows[k].T = (a >= 0 && b < rows.length) ? va + (vb - va) * (k - a) / (b - a) : (a >= 0 ? va : vb);
}
for (let k = 1; k < rows.length; k++) rows[k].T = Math.max(rows[k].T, rows[k - 1].T);
const cS = rows.map(r => r.s), cT = rows.map(r => r.T);

const S = tf => {
  if (tf <= cT[0]) return cS[0];
  if (tf >= cT[cT.length - 1]) return cS[cS.length - 1];
  let lo = 0, hi = cT.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cT[m] <= tf) lo = m; else hi = m; }
  const k = (tf - cT[lo]) / Math.max(cT[hi] - cT[lo], 1e-6);
  return cS[lo] + (cS[hi] - cS[lo]) * k;
};

const N = 40, d = 0.025;                    // 41 档，中心差分（0.025 一档）
const v = [];
for (let i = 0; i <= N; i++) {
  const r = i / N;
  const a = S(Math.max(0, r - d) * T_FIELD), b = S(Math.min(1, r + d) * T_FIELD);
  v.push(Math.max(1, (b - a) / (Math.min(1, r + d) - Math.max(0, r - d))));  // m / ratio
}
const ref = v.slice(2, 7).reduce((a, b) => a + b, 0) / 5;   // 前段基准（0.10~0.30）
const ss = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const raw = v.map((x, i) => {
  const tgt = Math.max(1, Math.min(CAP, TARGET * ref / x));   // 只加速、不减速
  return 1 + (tgt - 1) * ss((i / N - 0.26) / 0.06);         // 0~0.26 不动，0.26~0.32 接入
});
const pace = raw.map((x, i) => {
  const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
  return +((a + x + b) / 3).toFixed(2);
});

// 分段视觉速度（km / 墙钟秒），默认工况 1.2 亿 = 585 s，SIM 18，1.5×，slow 0.30@0.86
function segSpeed(total, SIM, SPD, kSlow, table) {
  const marks = [0, 0.35, 0.5, 0.7, 0.9, 1.0];
  let t = 0, dt = 1 / 120, real = 0, pr = 0, mi = 1;
  const out = [];
  while (t < total - 1e-6) {
    const r = t / total;
    const x = Math.min(N, Math.round(r * N));
    const p = table ? table[x] : 1;
    const slow = 1 - kSlow * ss((r - 0.86) / 0.06);
    t = Math.min(total, t + dt * SIM * SPD * slow * p); real += dt;
    if (mi < marks.length && t / total >= marks[mi] - 1e-9) {
      out.push(((S(marks[mi] * T_FIELD) - S(marks[mi - 1] * T_FIELD)) / 1000 / (real - pr)).toFixed(2));
      pr = real; mi++;
    }
  }
  return { total: +real.toFixed(1), out };
}
const before = segSpeed(585, 18, 1.5, 0.30, null);
const after = segSpeed(585, 18, 1.5, 0.30, pace);

console.log('// 前段基准推进 = ' + Math.round(ref) + ' m/ratio');
console.log('const PACE_TABLE = [' + pace.join(', ') + '];');
console.log('改前：全程 ' + before.total + ' s，分段视觉速度 km/s = ' + before.out.join(' | '));
console.log('改后：全程 ' + after.total + ' s，分段视觉速度 km/s = ' + after.out.join(' | '));
