// 解析 PNG，找出顶栏内「胶囊条」的左右边界（用户截图几何核对）
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const path = process.argv[2];
const buf = readFileSync(path);

let off = 8;
let W = 0, H = 0, bitDepth = 0, colorType = 0, interlace = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') {
    W = data.readUInt32BE(0); H = data.readUInt32BE(4);
    bitDepth = data[8]; colorType = data[9]; interlace = data[12];
  } else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  off += 12 + len;
}
if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported png ${bitDepth}/${interlace}`);
const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
if (!ch) throw new Error('unsupported colorType ' + colorType);

const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = W * ch;
const out = Buffer.alloc(H * stride);
let pos = 0;
for (let y = 0; y < H; y++) {
  const f = raw[pos++];
  const rowIn = raw.subarray(pos, pos + stride); pos += stride;
  const rowOut = out.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= ch ? rowOut[x - ch] : 0;
    const b = prev[x];
    const c = x >= ch ? prev[x - ch] : 0;
    let v = rowIn[x];
    if (f === 1) v += a;
    else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    rowOut[x] = v & 0xff;
  }
}

const px = (x, y) => {
  const i = y * stride + x * ch;
  return [out[i], out[i + 1], out[i + 2]];
};
const lum = (x, y) => { const [r, g, b] = px(x, y); return 0.299 * r + 0.587 * g + 0.114 * b; };

console.log('size', W, H, 'ch', ch);
// 打印若干行的亮度剖面（每 10 px 采样），找出胶囊边界
const bandY = process.argv[3] ? Number(process.argv[3]) : Math.round(H * 0.28);
for (const y of [Math.round(H * 0.15), Math.round(H * 0.25), Math.round(H * 0.35)]) {
  const edges = [];
  let prev = lum(0, y);
  for (let x = 1; x < W; x++) {
    const v = lum(x, y);
    if (Math.abs(v - prev) > 6) edges.push(`${x}(+${(v - prev).toFixed(0)})`);
    prev = v;
  }
  console.log(`row y=${y} jumps:`, edges.slice(0, 40).join(' '));
}
// 胶囊条背景检测：与 y=2（顶部纯背景）比较，找到横向连续亮起的区间
const refY = 1;
const bright = [];
for (let x = 0; x < W; x++) {
  const d = lum(x, bandY) - (lum(x, refY) + lum(x, H - 3)) / 2;
  bright.push(d);
}
let runs = [], start = null;
for (let x = 0; x < W; x++) {
  const on = bright[x] > 3;
  if (on && start === null) start = x;
  if (!on && start !== null) { if (x - start > 20) runs.push([start, x - 1]); start = null; }
}
if (start !== null && W - start > 20) runs.push([start, W - 1]);
console.log('bright runs at y=' + bandY + ':', JSON.stringify(runs));
