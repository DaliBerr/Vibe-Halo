"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..", "build");
const iconDir = path.join(root, "generated-icons");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const px = Math.max(left + radius, Math.min(right - radius, x));
  const py = Math.max(top + radius, Math.min(bottom - radius, y));
  const dx = x - px;
  const dy = y - py;
  return dx * dx + dy * dy <= radius * radius;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 512;
  const rect = { left: 36 * scale, top: 104 * scale, right: 476 * scale, bottom: 408 * scale, radius: 152 * scale };
  const dot = { x: 158 * scale, y: 256 * scale, radius: 44 * scale };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      let color = [0, 0, 0, 0];
      if (insideRoundedRect(x + 0.5, y + 0.5, rect.left, rect.top, rect.right, rect.bottom, rect.radius)) color = [17, 19, 24, 255];
      const dx = x + 0.5 - dot.x;
      const dy = y + 0.5 - dot.y;
      if (dx * dx + dy * dy <= dot.radius * dot.radius) color = [114, 229, 165, 255];
      const inBar = (x >= 246 * scale && x <= 385 * scale && y >= 190 * scale && y <= 214 * scale)
        || (x >= 246 * scale && x <= 385 * scale && y >= 244 * scale && y <= 268 * scale)
        || (x >= 246 * scale && x <= 348 * scale && y >= 298 * scale && y <= 322 * scale);
      if (inBar) color = [255, 255, 255, 255];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND"),
  ]);
}

fs.mkdirSync(iconDir, { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconDir, `${size}x${size}.png`), render(size));
}
fs.writeFileSync(path.join(root, "icon.png"), render(512));
process.stdout.write("Generated Vibe Halo platform icons.\n");
