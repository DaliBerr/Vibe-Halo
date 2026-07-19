"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const assetDir = path.join(projectRoot, "assets", "icons");
const buildDir = path.join(projectRoot, "build");
const iconDir = path.join(buildDir, "generated-icons");
const sizes = [16, 32, 48, 64, 128, 256, 512];

function validatePng(buffer, size, filePath) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`Invalid PNG icon: ${filePath}`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  if (width !== size || height !== size) {
    throw new Error(`Expected ${size}x${size} icon, got ${width}x${height}: ${filePath}`);
  }
  if (colorType !== 6) {
    throw new Error(`Icon must be RGBA with transparency (PNG color type 6): ${filePath}`);
  }
}

fs.mkdirSync(iconDir, { recursive: true });
for (const size of sizes) {
  const source = path.join(assetDir, `${size}x${size}.png`);
  const icon = fs.readFileSync(source);
  validatePng(icon, size, source);
  fs.writeFileSync(path.join(iconDir, `${size}x${size}.png`), icon);
}
const applicationIcon = fs.readFileSync(path.join(assetDir, "1024x1024.png"));
validatePng(applicationIcon, 1024, path.join(assetDir, "1024x1024.png"));
fs.writeFileSync(path.join(buildDir, "icon.png"), applicationIcon);
process.stdout.write("Prepared Vibe Halo platform icons from the transparent master assets.\n");
