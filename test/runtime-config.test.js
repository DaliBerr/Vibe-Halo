"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { SERVER_ID } = require("../src/constants");
const { clearRuntime, readRuntime, validateRuntime, writeRuntime } = require("../src/runtime-config");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("writes, validates and owner-clears runtime identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-runtime-"));
  roots.push(root);
  const filePath = path.join(root, "runtime.json");
  const value = { app: SERVER_ID, port: 34567, ownerPid: 123, token: "a".repeat(64), startedAt: new Date().toISOString() };
  writeRuntime(value, { filePath });
  assert.equal(readRuntime({ filePath, processAlive: pid => pid === 123 }).port, 34567);
  assert.equal(clearRuntime(999, { filePath }), false);
  assert.equal(clearRuntime(123, { filePath }), true);
  assert.equal(fs.existsSync(filePath), false);
});

test("rejects stale and malformed runtime files", () => {
  const value = { app: SERVER_ID, port: 34567, ownerPid: 123, token: "a".repeat(64) };
  assert.equal(validateRuntime(value, { processAlive: () => false }), null);
  assert.equal(validateRuntime({ ...value, app: "other" }, { requireAlive: false }), null);
  assert.equal(validateRuntime({ ...value, token: "short" }, { requireAlive: false }), null);
});
