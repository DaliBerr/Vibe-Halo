"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_FILE_BYTES,
  HISTORY_MAX_RECORD_BYTES,
  HISTORY_RETENTION_MS,
  HistoryStore,
  normalizeRecord,
} = require("../src/history-store");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "history.json");
}

function plaintextStore(t, options = {}) {
  const store = new HistoryStore({
    filePath: temporary(t),
    safeStorage: { isEncryptionAvailable: () => false },
    platform: "linux",
    ...options,
  });
  store.load();
  return store;
}

test("persists bounded visible details and redacts structured secrets", t => {
  const store = plaintextStore(t);
  const record = store.append({
    id: "11111111-1111-4111-8111-111111111111",
    kind: "approval",
    agentId: "zcode",
    agentName: "ZCode",
    sessionId: "s1",
    toolName: "Bash",
    cwd: "C:\\repo",
    toolInput: {
      command: "echo visible",
      environment: { API_TOKEN: "hidden", NORMAL: "shown" },
      sourcePid: 12,
      pidChain: [12, 1],
    },
    answers: { choice: "A" },
    outcome: "allow",
  });

  assert.equal(record.toolInput.command, "echo visible");
  assert.equal(record.toolInput.environment.API_TOKEN, "[REDACTED]");
  assert.equal(record.toolInput.environment.NORMAL, "shown");
  assert.equal(Object.hasOwn(record.toolInput, "sourcePid"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= HISTORY_MAX_RECORD_BYTES);
  store.flush();
  const envelope = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  assert.equal(envelope.mode, "plaintext");
  assert.equal(envelope.entries[0].answers.choice, "A");
  const secretAnswer = store.append({ kind: "question", agentId: "codex", answers: { api_token: "secret" } });
  assert.equal(secretAnswer.answers.api_token, "[REDACTED]");
});

test("encrypts the payload when a secure backend is available", t => {
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
      return Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: value => {
      const tag = value.subarray(value.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.alloc(12));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(value.subarray(0, -16)), decipher.final()]).toString("utf8");
    },
  };
  const filePath = temporary(t);
  const first = new HistoryStore({ filePath, safeStorage, platform: "win32" });
  first.load();
  first.append({ kind: "plan", agentId: "codex", content: "private plan", outcome: "ready" });
  first.flush();
  const disk = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(disk, /private plan/);
  const second = new HistoryStore({ filePath, safeStorage, platform: "win32" });
  second.load();
  assert.equal(second.list()[0].summary, "private plan");
});

test("prunes expired records and the oldest records beyond 200", t => {
  let now = 2_000_000_000_000;
  const store = plaintextStore(t, { now: () => now });
  store.append({ kind: "approval", agentId: "codex", createdAt: now - HISTORY_RETENTION_MS - 1, finalizedAt: now - HISTORY_RETENTION_MS - 1 });
  for (let index = 0; index < HISTORY_MAX_ENTRIES + 5; index += 1) {
    store.append({ kind: "question", agentId: "codex", finalizedAt: now + index, title: String(index) });
  }
  assert.equal(store.snapshot().count, HISTORY_MAX_ENTRIES);
  assert.equal(store.list()[0].title, String(HISTORY_MAX_ENTRIES + 4));
  assert.equal(store.list().some(item => item.title === "0"), false);
});

test("corrupt history fails safely without overwriting the original", t => {
  const filePath = temporary(t);
  fs.writeFileSync(filePath, "not-json", "utf8");
  const store = new HistoryStore({ filePath, safeStorage: { isEncryptionAvailable: () => false } });
  store.load();
  assert.equal(store.snapshot().mode, "memory");
  assert.match(store.snapshot().lastError, /Unexpected token|JSON/);
  store.append({ kind: "plan", agentId: "codex", content: "memory only" });
  assert.equal(store.flush(), false);
  assert.equal(fs.readFileSync(filePath, "utf8"), "not-json");
});

test("rejects unknown kinds and truncates oversized records", () => {
  assert.equal(normalizeRecord({ kind: "completion" }), null);
  const record = normalizeRecord({ kind: "plan", agentId: "codex", content: "好".repeat(100_000) });
  assert.equal(record.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= HISTORY_MAX_RECORD_BYTES);
});

test("enforces depth and the sixteen MiB aggregate limit", t => {
  const store = plaintextStore(t);
  let nested = { value: "visible" };
  for (let index = 0; index < 12; index += 1) nested = { nested };
  const deep = store.append({ kind: "approval", agentId: "codex", toolInput: nested });
  assert.match(JSON.stringify(deep.toolInput), /\[TRUNCATED\]/);

  const now = Date.now();
  const large = "x".repeat(64 * 1024);
  store.entries = Array.from({ length: HISTORY_MAX_ENTRIES }, (_, index) => normalizeRecord({
    kind: "approval",
    agentId: "codex",
    title: String(index),
    toolInput: { command: large, patch: large },
    createdAt: now - index,
    finalizedAt: now - index,
  }));
  store.prune(false);
  store.flush();
  assert.ok(fs.statSync(store.filePath).size <= HISTORY_MAX_FILE_BYTES);
  assert.ok(store.snapshot().count < HISTORY_MAX_ENTRIES);
});

test("Linux basic_text is diagnosed as plaintext even when encryption reports available", t => {
  const store = new HistoryStore({
    filePath: temporary(t),
    platform: "linux",
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
    },
  });
  store.load();
  assert.equal(store.snapshot().mode, "plaintext");
});

test("encryption failure keeps in-memory history and does not create a partial file", t => {
  const filePath = temporary(t);
  const store = new HistoryStore({
    filePath,
    platform: "win32",
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error("keyring-locked"); },
    },
  });
  store.load();
  store.append({ kind: "plan", agentId: "codex", content: "keep me", outcome: "ready" });
  assert.equal(store.flush(), false);
  assert.equal(store.snapshot().count, 1);
  assert.equal(store.list()[0].summary, "keep me");
  assert.equal(fs.existsSync(filePath), false);
});

test("encrypted envelope size pruning updates the visible count", t => {
  const filePath = temporary(t);
  const store = new HistoryStore({
    filePath,
    platform: "win32",
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value, "utf8"),
    },
  });
  store.load();
  const now = Date.now();
  const large = "x".repeat(64 * 1024);
  store.entries = Array.from({ length: HISTORY_MAX_ENTRIES }, (_, index) => normalizeRecord({
    kind: "approval",
    agentId: "codex",
    toolInput: { command: large, patch: large },
    createdAt: now - index,
    finalizedAt: now - index,
  }));
  store.prune(false);
  const before = store.snapshot().count;
  const changes = [];
  store.on("changed", (_snapshot, reason) => changes.push(reason));
  assert.equal(store.flush(), true);
  assert.ok(fs.statSync(filePath).size <= HISTORY_MAX_FILE_BYTES);
  assert.ok(store.snapshot().count < before);
  assert.deepEqual(changes, ["capacity-pruned"]);
});
