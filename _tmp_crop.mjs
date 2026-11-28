// 裁剪 + 放大 PNG（无依赖），用于放大查看顶栏细节
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decode(path) {
  const buf = readFileSync(path);
  let off = 8, W = 0, H = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 6 ? 4 : 3;
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported');
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
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      rowOut[x] = v & 0xff;
    }
  }
  return { W, H, ch, px: out };
}

const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(W, H, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const src = process.argv[2];
const [x0, y0, w, h, scale, outPath] = process.argv.slice(3).map((v, i) => (i === 5 ? v : Number(v)));
const img = decode(src);
const S = scale || 2;
const W2 = Math.round(w * S), H2 = Math.round(h * S);
const dst = Buffer.alloc(W2 * H2 * 3);
for (let y = 0; y < H2; y++) {
  const sy = Math.min(img.H - 1, y0 + Math.floor(y / S));
  for (let x = 0; x < W2; x++) {
    const sx = Math.min(img.W - 1, x0 + Math.floor(x / S));
    const si = sy * img.W * img.ch + sx * img.ch;
    const di = (y * W2 + x) * 3;
    dst[di] = img.px[si]; dst[di + 1] = img.px[si + 1]; dst[di + 2] = img.px[si + 2];
  }
}
writeFileSync(outPath, encode(W2, H2, dst));
console.log('wrote', outPath, W2, H2);
