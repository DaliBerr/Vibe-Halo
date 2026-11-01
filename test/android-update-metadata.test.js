"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { generate } = require("../scripts/generate-android-update-metadata");

test("Android update metadata binds the public filename, build code, source and exact APK bytes", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "halo-android-update-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("halo-android-update-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const apk = path.join(directory, "Vibe-Halo-Mobile-0.6.6.apk");
  const bytes = Buffer.from("Synthetic APK bytes for metadata only");
  fs.writeFileSync(apk, bytes);
  const options = { apk, versionName: "0.6.6", versionCode: 7, sourceCommit: "a".repeat(40) };
  const result = generate(options);
  const manifest = JSON.parse(fs.readFileSync(result.output, "utf8"));
  assert.equal(manifest.packageName, "com.vibe.halo.mobile");
  assert.equal(manifest.versionCode, 7);
  assert.equal(manifest.apkName, path.basename(apk));
  assert.equal(manifest.sourceCommit, options.sourceCommit);
  assert.equal(manifest.size, bytes.length);
  assert.equal(manifest.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  for (const invalid of [{ versionCode: 0 }, { versionCode: 1.5 }, { versionCode: 2147483648 }, { sourceCommit: "main" }, { versionName: "../0.6.6" }, { versionName: "0.6.7" }]) {
    assert.throws(() => generate({ ...options, ...invalid }));
  }
  fs.writeFileSync(apk, "");
  assert.throws(() => generate(options));
});
