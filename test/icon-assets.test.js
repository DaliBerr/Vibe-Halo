"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const sizes = [16, 32, 48, 64, 128, 256, 512];

function pngMetadata(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(buffer.toString("ascii", 12, 16), "IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
  };
}

test("transparent icon assets cover every packaged platform size", () => {
  for (const size of [...sizes, 1024]) {
    const metadata = pngMetadata(path.join(root, "assets", "icons", `${size}x${size}.png`));
    assert.deepEqual(metadata, { width: size, height: size, colorType: 6 });
  }
});

test("icon preparation copies the tracked transparent assets exactly", () => {
  childProcess.execFileSync(process.execPath, [path.join(root, "scripts", "generate-icons.js")], { cwd: root });
  for (const size of sizes) {
    const source = fs.readFileSync(path.join(root, "assets", "icons", `${size}x${size}.png`));
    const generated = fs.readFileSync(path.join(root, "build", "generated-icons", `${size}x${size}.png`));
    assert.deepEqual(generated, source);
  }
  assert.deepEqual(
    fs.readFileSync(path.join(root, "build", "icon.png")),
    fs.readFileSync(path.join(root, "assets", "icons", "1024x1024.png")),
  );
});

test("both READMEs display the black icon variant at the top", () => {
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const contents = fs.readFileSync(path.join(root, name), "utf8");
    assert.match(contents, /<img src="docs\/assets\/vibe-halo-icon-black\.png" width="160"/);
  }
  assert.deepEqual(
    pngMetadata(path.join(root, "docs", "assets", "vibe-halo-icon-black.png")),
    { width: 512, height: 512, colorType: 2 },
  );
});
