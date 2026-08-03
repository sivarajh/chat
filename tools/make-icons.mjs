// Generates the PWA icon set. Run with: node tools/make-icons.mjs
//
// Written against Node's built-in zlib so the project needs no image
// dependencies. Output goes to docs/icons/ and public/icons/.

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

// ---------- minimal PNG encoder (8-bit RGBA) ----------
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
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- tiny drawing helpers ----------
function canvas(size) {
  return { size, px: Buffer.alloc(size * size * 4) };
}

function blend(c, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size || a <= 0) return;
  const i = (y * c.size + x) * 4;
  const dst = c.px[i + 3] / 255;
  const out = a + dst * (1 - a);
  c.px[i]     = Math.round((r * a + c.px[i]     * dst * (1 - a)) / out);
  c.px[i + 1] = Math.round((g * a + c.px[i + 1] * dst * (1 - a)) / out);
  c.px[i + 2] = Math.round((b * a + c.px[i + 2] * dst * (1 - a)) / out);
  c.px[i + 3] = Math.round(out * 255);
}

// Signed distance to a rounded rectangle; negative means inside. Used with a
// 1px smoothstep so edges come out antialiased.
function roundedRectSdf(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(x - cx) - hx;
  const dy = Math.abs(y - cy) - hy;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

function fillSdf(c, color, sdf) {
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      const a = Math.min(Math.max(0.5 - d, 0), 1); // 1px antialiased edge
      if (a > 0) blend(c, x, y, color, a);
    }
  }
}

const BLUE = [0x58, 0x56, 0xd6];
const DEEP = [0x3e, 0x3c, 0xaf];
const WHITE = [0xff, 0xff, 0xff];

// A speech bubble: rounded body plus a tail on the lower left.
function drawBubble(c, cxScale) {
  const S = c.size;
  const k = cxScale; // content scale (smaller for maskable safe zone)
  const pad = (1 - k) / 2;
  const x0 = S * (pad + 0.16 * k);
  const x1 = S * (pad + 0.84 * k);
  const y0 = S * (pad + 0.20 * k);
  const y1 = S * (pad + 0.64 * k);
  const r = S * 0.11 * k;

  fillSdf(c, WHITE, (x, y) => roundedRectSdf(x, y, x0, y0, x1, y1, r));

  // Tail: a small rounded triangle hanging off the bottom-left of the body.
  const tipX = S * (pad + 0.28 * k);
  const tipY = S * (pad + 0.82 * k);
  const baseL = S * (pad + 0.30 * k);
  const baseR = S * (pad + 0.50 * k);
  fillSdf(c, WHITE, (x, y) => {
    if (y < y1 - 1 || y > tipY) return 1;
    const t = (y - y1) / (tipY - y1);          // 0 at body, 1 at tip
    const left = baseL + (tipX - baseL) * t;
    const right = baseR + (tipX - baseR) * t;
    if (x < left || x > right) return 1;
    return -1;
  });

  // Three dots, suggesting a conversation.
  const dotY = (y0 + y1) / 2;
  const dotR = S * 0.045 * k;
  for (const f of [0.34, 0.5, 0.66]) {
    const dx = x0 + (x1 - x0) * f;
    fillSdf(c, DEEP, (x, y) => Math.hypot(x - dx, y - dotY) - dotR);
  }
}

function makeIcon(size, { maskable }) {
  const c = canvas(size);
  if (maskable) {
    // Maskable icons are cropped to a circle by the OS, so the background must
    // bleed to the edges and the artwork must sit inside the ~80% safe zone.
    fillSdf(c, BLUE, () => -1);
    drawBubble(c, 0.78);
  } else {
    const r = size * 0.22;
    fillSdf(c, BLUE, (x, y) => roundedRectSdf(x, y, 0, 0, size, size, r));
    drawBubble(c, 1);
  }
  return encodePng(size, size, c.px);
}

const outputs = [
  ["icon-192.png", makeIcon(192, { maskable: false })],
  ["icon-512.png", makeIcon(512, { maskable: false })],
  ["icon-maskable-512.png", makeIcon(512, { maskable: true })],
  ["apple-touch-icon.png", makeIcon(180, { maskable: true })],
];

for (const dir of ["docs/icons", "public/icons"]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, buf] of outputs) {
    fs.writeFileSync(path.join(dir, name), buf);
    console.log(`wrote ${dir}/${name} (${buf.length} bytes)`);
  }
}
