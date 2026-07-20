"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { generate, validVersion } = require("../scripts/generate-update-metadata");
const { classifySigningTarget, sign } = require("../scripts/stage-windows-signing");
const { cleanPublisher, updateConfig, writeConfig } = require("../scripts/write-app-update-config");

test("external signing hook stages installers and injects the signed uninstaller", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-signing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousStage = process.env.VIBE_HALO_SIGN_STAGE_DIR;
  const previousSigned = process.env.VIBE_HALO_SIGNED_UNINSTALLER;
  const previousElevate = process.env.VIBE_HALO_SIGNED_ELEVATE;
  t.after(() => {
    if (previousStage == null) delete process.env.VIBE_HALO_SIGN_STAGE_DIR;
    else process.env.VIBE_HALO_SIGN_STAGE_DIR = previousStage;
    if (previousSigned == null) delete process.env.VIBE_HALO_SIGNED_UNINSTALLER;
    else process.env.VIBE_HALO_SIGNED_UNINSTALLER = previousSigned;
    if (previousElevate == null) delete process.env.VIBE_HALO_SIGNED_ELEVATE;
    else process.env.VIBE_HALO_SIGNED_ELEVATE = previousElevate;
  });
  const stage = path.join(root, "stage");
  const uninstaller = path.join(root, "Vibe-Halo-Setup-0.3.0-x64.__uninstaller.exe");
  const installer = path.join(root, "Vibe-Halo-Setup-0.3.0-x64.exe");
  const elevate = path.join(root, "elevate.exe");
  fs.writeFileSync(uninstaller, "unsigned-uninstaller");
  fs.writeFileSync(installer, "unsigned-installer");
  fs.writeFileSync(elevate, "unsigned-elevate");
  process.env.VIBE_HALO_SIGN_STAGE_DIR = stage;

  await sign({ path: uninstaller });
  await sign({ path: installer });
  await sign({ path: elevate });
  assert.equal(fs.readFileSync(path.join(stage, "uninstaller.exe"), "utf8"), "unsigned-uninstaller");
  assert.equal(fs.readFileSync(path.join(stage, "installer.exe"), "utf8"), "unsigned-installer");
  assert.equal(fs.readFileSync(path.join(stage, "elevate.exe"), "utf8"), "unsigned-elevate");

  const signed = path.join(root, "signed-uninstaller.exe");
  fs.writeFileSync(signed, "signed-uninstaller");
  process.env.VIBE_HALO_SIGNED_UNINSTALLER = signed;
  const signedElevate = path.join(root, "signed-elevate.exe");
  fs.writeFileSync(signedElevate, "signed-elevate");
  process.env.VIBE_HALO_SIGNED_ELEVATE = signedElevate;
  await sign({ path: uninstaller });
  await sign({ path: elevate });
  assert.equal(fs.readFileSync(uninstaller, "utf8"), "signed-uninstaller");
  assert.equal(fs.readFileSync(elevate, "utf8"), "signed-elevate");
  assert.equal(classifySigningTarget(elevate), "elevate");
  assert.equal(classifySigningTarget(uninstaller), "uninstaller");
  assert.equal(classifySigningTarget(installer), "installer");
  assert.equal(classifySigningTarget(path.join(root, "Vibe Halo.exe")), "unknown");
});

test("signed installer metadata and checksums are regenerated from final bytes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-update-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousDate = process.env.VIBE_HALO_RELEASE_DATE;
  t.after(() => {
    if (previousDate == null) delete process.env.VIBE_HALO_RELEASE_DATE;
    else process.env.VIBE_HALO_RELEASE_DATE = previousDate;
  });
  process.env.VIBE_HALO_RELEASE_DATE = "2026-07-18T12:00:00.000Z";
  const installer = path.join(root, "Vibe-Halo-Setup-0.3.0-x64.exe");
  const bytes = crypto.randomBytes(96 * 1024);
  fs.writeFileSync(installer, bytes);

  const result = await generate({ installer, version: "0.3.0", "out-dir": root });
  const expectedSha512 = crypto.createHash("sha512").update(bytes).digest("base64");
  const latest = fs.readFileSync(result.latestPath, "utf8");
  const sums = fs.readFileSync(result.checksumsPath, "utf8");

  assert.equal(result.sha512, expectedSha512);
  assert.equal(result.size, bytes.length);
  assert.ok(fs.statSync(result.blockMapPath).size > 0);
  assert.match(latest, /version: "0\.3\.0"/);
  assert.match(latest, new RegExp(expectedSha512.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(latest, /releaseDate: "2026-07-18T12:00:00\.000Z"/);
  assert.match(sums, /Vibe-Halo-Setup-0\.3\.0-x64\.exe/);
  assert.match(sums, /latest\.yml/);
  assert.match(sums, /\.exe\.blockmap/);
  assert.equal(validVersion("0.3.0"), true);
  assert.equal(validVersion("0.3"), false);
});

test("signed prepackaged apps receive a public update config with an exact publisher", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-app-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Vibe Halo.exe"), "signed-app-placeholder");

  const publisher = "CN=SignPath Foundation, O=SignPath Foundation";
  const target = writeConfig(root, publisher);
  const content = fs.readFileSync(target, "utf8");

  assert.equal(content, updateConfig(publisher));
  assert.match(content, /provider: github/);
  assert.match(content, /updaterCacheDirName: vibe-halo-updater/);
  assert.match(content, /publisherName:\n  - "CN=SignPath Foundation, O=SignPath Foundation"/);
  assert.equal(cleanPublisher("bad\nname"), "");
  assert.throws(() => updateConfig("bad\nname"), /bounded and single-line/);
});

test("unsigned release apps receive a public update config without a publisher", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-unsigned-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Vibe Halo.exe"), "unsigned-app-placeholder");

  const target = writeConfig(root);
  const content = fs.readFileSync(target, "utf8");

  assert.equal(content, updateConfig());
  assert.match(content, /provider: github/);
  assert.match(content, /channel: latest/);
  assert.doesNotMatch(content, /publisherName/);
});
