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
  "/src/dsh-integration.js",
  "/hooks/integrations/deepseek-harness/index.mjs",
  "/hooks/integrations/deepseek-harness/package.json",
  "/src/decision-service.js",
  "/src/remote/event-projector.js",
  "/src/remote/remote-service.js",
  "/src/remote/device-credential-store.js",
  "/src/remote/event-journal.js",
  "/src/remote/lan-service.js",
  "/packages/protocol/src/crypto.mjs",
  "/packages/protocol/src/device-profile.mjs",
  "/packages/protocol/package.json",
  "/packages/protocol/src/index.js",
  "/packages/protocol/generated/validators.js",
  "/src/session-origin-store.js",
  "/src/history-store.js",
  "/src/settings-service.js",
  "/src/history-presenter.js",
  "/src/remote/companion-actions.js",
  "/src/settings-renderer/icons/codex.svg",
  "/src/settings-renderer/icons/claude-code.svg",
  "/src/settings-renderer/icons/deepseek-harness.svg",
  "/src/settings-renderer/icons/LICENSE.txt",
  "/src/settings-window-controller.js",
  "/src/settings-preload.js",
  "/src/settings-renderer/index.html",
  "/src/settings-renderer/style.css",
  "/src/settings-renderer/renderer.js",
  "/hooks/vibe-halo-hook.js",
  "/hooks/vibe-halo-hook.ps1",
]) {
  if (!entries.has(required)) throw new Error(`packaged file missing: ${required}`);
}

for (const entry of entries) {
  if (/^\/(?:services\/relay|apps\/android|packages\/protocol\/(?:test|fixtures|scripts|schemas))\//.test(entry)
    || /\/(?:\.dev\.vars(?:\..*)?|google-services\.json|service-account[^/]*\.json)$/.test(entry)) {
    throw new Error(`development or credential file packaged: ${entry}`);
  }
}

const metadata = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
if (metadata.version !== expectedVersion) throw new Error(`version mismatch: ${metadata.version}`);
if (metadata.license !== "AGPL-3.0-only") throw new Error(`license mismatch: ${metadata.license}`);
if (metadata.autoUpdateEnabled !== expectAutoUpdate) {
  throw new Error(`auto-update mismatch: expected ${expectAutoUpdate}, received ${metadata.autoUpdateEnabled}`);
}

process.stdout.write(`Verified Vibe Halo ${expectedVersion} package at ${resourcesDir}\n`);
