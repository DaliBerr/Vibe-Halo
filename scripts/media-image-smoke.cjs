"use strict";
// Native codec check, run with: npx electron scripts/media-image-smoke.cjs
const { app, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { imageSize } = require("image-size");
const { rasterize, MAX_IMAGE } = require("../src/remote/media-store");
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(path.join(__dirname, "../assets/icons/1024x1024.png"));
  assert.equal(icon.isEmpty(), false);
  const width = 2300, height = 1500, pixels = Buffer.alloc(width * height * 4);
  // Deterministic detailed image exercises resizing and the byte-size fallback.
  let state = 12345;
  for (let i = 0; i < pixels.length; i += 4) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[i] = state & 255; pixels[i + 1] = state >>> 8 & 255; pixels[i + 2] = state >>> 16 & 255; pixels[i + 3] = 255; }
  const noise = nativeImage.createFromBitmap(pixels, { width, height });
  for (const input of [icon.toPNG(), icon.toJPEG(90), noise.toJPEG(90)]) {
    const result = rasterize(input);
    for (const name of ["preview", "full"]) {
      const part = result[name], bytes = Buffer.from(part.data, "base64"), decoded = nativeImage.createFromBuffer(bytes);
      assert.equal(decoded.isEmpty(), false); assert.deepEqual(decoded.getSize(), { width: part.width, height: part.height });
      assert.equal(part.mime, imageSize(bytes).type === "png" ? "image/png" : "image/jpeg");
      assert.ok(part.size <= (name === "preview" ? 48 * 1024 : MAX_IMAGE));
      assert.ok(Math.max(part.width, part.height) <= (name === "preview" ? 480 : 2048));
    }
  }
  console.log("Native image smoke passed: PNG, JPEG, resize, byte cap and decodable previews/full views."); app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
