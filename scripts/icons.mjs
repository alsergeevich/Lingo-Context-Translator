// Generates extension icons as PNG without any external dependency.
// Run: node scripts/icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'public', 'icons');

/* ------------------------------- PNG encoder ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (width * 4 + 1);
    raw[off] = 0; // filter: none
    rgba.copy(raw, off + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- drawing -------------------------------- */

const hex = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Signed distance to a rounded rectangle (negative inside). */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r;
}

/** Signed distance to a triangle-free "tail" polygon approximated by half-planes. */
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const edges = [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay],
  ];
  let d = -Infinity;
  for (const [x1, y1, x2, y2] of edges) {
    const ex = x2 - x1;
    const ey = y2 - y1;
    const len = Math.hypot(ex, ey) || 1;
    // signed distance to the line; assumes CCW winding
    const dist = ((ex * (py - y1) - ey * (px - x1)) / len) * -1;
    d = Math.max(d, dist);
  }
  return d;
}

const C1 = hex('#6366f1');
const C2 = hex('#22d3ee');
const WHITE = [1, 1, 1];

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling grid
  const S = (v) => v; // normalized coordinates helper

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const px = S(u);
          const py = S(v);

          // background: rounded square with diagonal gradient
          const bgD = sdRoundRect(px, py, 0.5, 0.5, 0.5, 0.5, 0.225);
          if (bgD > 0) continue;
          const t = Math.min(1, Math.max(0, (px + py) / 2));
          let col = mix(C1, C2, t);

          // bubble A (back, upper-left), filled white
          const dA = sdRoundRect(px, py, 0.352, 0.348, 0.208, 0.142, 0.075);
          const tailA = sdTriangle(px, py, 0.215, 0.455, 0.215, 0.585, 0.345, 0.475);
          const shapeA = Math.min(dA, tailA);

          // bubble B (front, lower-right), filled white
          const dB = sdRoundRect(px, py, 0.646, 0.648, 0.208, 0.142, 0.075);
          const tailB = sdTriangle(px, py, 0.785, 0.755, 0.785, 0.885, 0.655, 0.775);
          const shapeB = Math.min(dB, tailB);

          // keep a gradient gap around A where it overlaps B, so they read as two bubbles
          const gap = shapeB <= 0 && shapeA > 0 && shapeA < 0.05;

          if (shapeA <= 0) col = WHITE;
          else if (shapeB <= 0 && !gap) col = WHITE;

          r += col[0];
          g += col[1];
          b += col[2];
          a += 1;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) {
        buf[i + 3] = 0;
        continue;
      }
      buf[i] = Math.round((r / a) * 255);
      buf[i + 1] = Math.round((g / a) * 255);
      buf[i + 2] = Math.round((b / a) * 255);
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, buf);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = render(size);
  writeFileSync(path.join(OUT, `icon-${size}.png`), png);
  console.log(`icon-${size}.png  ${png.length} bytes`);
}
