"use strict";

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const resourcesDir = path.resolve(process.argv[2] || "");
const expectedVersion = String(process.argv[3] || "").trim();
const expectAutoUpdate = process.argv.includes("--expect-auto-update");
if (!resourcesDir || !expectedVersion) {
  throw new Error("usage: node scripts/verify-packaged-app.js <resources-dir> <version> [--expect-auto-update]");
}

const asarPath = path.join(resourcesDir, "app.asar");
const unpackedHook = path.join(resourcesDir, "app.asar.unpacked", "hooks", "vibe-halo-hook.js");
if (!fs.existsSync(asarPath)) throw new Error(`app.asar missing: ${asarPath}`);
if (!fs.existsSync(unpackedHook)) throw new Error(`unpacked Hook missing: ${unpackedHook}`);

const entries = new Set(asar.listPackage(asarPath).map(value => value.replace(/\\/g, "/")));
for (const required of [
  "/LICENSE",
  "/NOTICE.md",
  "/README.md",
  "/README.zh-CN.md",
  "/assets/icons/16x16.png",
  "/assets/icons/32x32.png",
  "/src/platform-adapter.js",
  "/src/history-store.js",
  "/src/history-window-controller.js",
  "/src/history-preload.js",
  "/src/history-renderer/index.html",
  "/src/history-renderer/style.css",
  "/src/history-renderer/renderer.js",
  "/hooks/vibe-halo-hook.js",
]) {
  if (!entries.has(required)) throw new Error(`packaged file missing: ${required}`);
}

const metadata = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
if (metadata.version !== expectedVersion) throw new Error(`version mismatch: ${metadata.version}`);
if (metadata.license !== "AGPL-3.0-only") throw new Error(`license mismatch: ${metadata.license}`);
if (metadata.autoUpdateEnabled !== expectAutoUpdate) {
  throw new Error(`auto-update mismatch: expected ${expectAutoUpdate}, received ${metadata.autoUpdateEnabled}`);
}

process.stdout.write(`Verified Vibe Halo ${expectedVersion} package at ${resourcesDir}\n`);
