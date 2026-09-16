"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DeviceCredentialStore } = require("../src/remote/device-credential-store");

test("standard JOSE signs then encrypts Unicode and rejects tampering, wrong keys and purposes", async () => {
  const c = await import("../packages/protocol/src/crypto.mjs");
  const pc = await c.generateIdentity("pc"), mobile = await c.generateIdentity("mobile");
  const message = { protocolVersion: 1, pcId: pc.deviceId, mobileId: mobile.deviceId, body: "中文🚀\n精确上下文" };
  const envelope = await c.seal(message, pc.signKey, mobile.encryptionKey);
  assert.deepEqual(await c.open(envelope, mobile.encryptionKey, pc.signKey), message);
  await assert.rejects(c.open(envelope, pc.encryptionKey, pc.signKey));
  await assert.rejects(c.open(envelope, mobile.encryptionKey, mobile.signKey));
  await assert.rejects(c.open(envelope, mobile.encryptionKey, pc.signKey, "decision"));
  const parts = envelope.split("."); parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
  await assert.rejects(c.open(parts.join("."), mobile.encryptionKey, pc.signKey));
  await assert.rejects(c.sign(message, pc.encryptionKey, "message"));
  assert.equal((await c.publicDevice(pc)).signKey.d, undefined);
  assert.equal(await c.pairingFingerprint({ a: 1, b: "测试" }), await c.pairingFingerprint({ b: "测试", a: 1 }));
});

test("JOSE rejects none, key URL lookup, compression, unknown headers and key-purpose confusion", async () => {
  const c = await import("../packages/protocol/src/crypto.mjs");
  const jose = await import("jose");
  const pc = await c.generateIdentity("pc");
  const key = await jose.importJWK(pc.signKey, "ES256");
  for (const extra of [{ jku: "https://invalid.example/keys" }, { x5u: "https://invalid.example/cert" }, { unexpected: true }]) {
    const signed = await new jose.CompactSign(new TextEncoder().encode('{"ok":true}'))
      .setProtectedHeader({ alg: "ES256", kid: pc.signKey.kid, typ: "vh1:message", ...extra }).sign(key);
    await assert.rejects(c.verify(signed, pc.signKey, "message"));
  }
  assert.throws(() => c.relayOrigin("http://example.com"));
  assert.throws(() => c.relayOrigin("https://example.com/path"));
  assert.throws(() => c.relayOrigin("https://name:secret@example.com"));
  assert.equal(c.relayOrigin("http://127.0.0.1:8787", true), "http://127.0.0.1:8787");
});

test("credentials refuse plaintext backends and corrupted storage is not overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-credential-"));
  const filePath = path.join(root, "identity.json");
  const bad = new DeviceCredentialStore({ filePath, platform: "linux", safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text",
  } });
  assert.throws(() => bad.save({ version: 1, bindings: [] }), /secure_storage_unavailable/);
  assert.equal(fs.existsSync(filePath), false);
  fs.writeFileSync(filePath, "corrupted");
  const store = new DeviceCredentialStore({ filePath, safeStorage: { isEncryptionAvailable: () => true, decryptString() { throw Error(); } } });
  assert.throws(() => store.load(), /credential_store_invalid/);
  assert.equal(fs.readFileSync(filePath, "utf8"), "corrupted");
  fs.rmSync(root, { recursive: true, force: true });
});
