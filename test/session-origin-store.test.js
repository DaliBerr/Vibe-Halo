"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionOriginStore, originKey } = require("../src/session-origin-store");

test("remembers bounded process origins by exact client and session", () => {
  let now = 1_000;
  const store = new SessionOriginStore({ now: () => now, ttlMs: 60_000 });
  assert.equal(store.remember({
    agentId: "Codex",
    sessionId: "session-1",
    sourcePid: 42,
    pidChain: [42, 21, 42, -1, "7"],
    cwd: "C:\\Work\\Demo",
  }), true);
  assert.deepEqual(store.get("codex", "session-1"), {
    sourcePid: 42,
    pidChain: [42, 21, 7],
    cwd: "C:\\Work\\Demo",
    updatedAt: 1_000,
  });
  assert.equal(store.get("zcode", "session-1"), null);
  assert.equal(store.get("codex", "session-2"), null);
  assert.equal(originKey("CODEX", "session-1"), "codex\u0000session-1");
});

test("rejects unknown sessions and entries without a valid process", () => {
  const store = new SessionOriginStore();
  assert.equal(store.remember({ agentId: "codex", sessionId: "codex:unknown", sourcePid: 10 }), false);
  assert.equal(store.remember({ agentId: "codex", sessionId: "session", sourcePid: 0, pidChain: [] }), false);
  assert.equal(store.remember({ agentId: "", sessionId: "session", sourcePid: 10 }), false);
  assert.equal(store.entries.size, 0);
});

test("expires stale origins and evicts the least recently used entry", () => {
  let now = 0;
  const store = new SessionOriginStore({ now: () => now, ttlMs: 100, maxEntries: 2 });
  store.remember({ agentId: "codex", sessionId: "one", sourcePid: 1 });
  now = 10;
  store.remember({ agentId: "codex", sessionId: "two", sourcePid: 2 });
  assert.equal(store.get("codex", "one").sourcePid, 1);
  now = 20;
  store.remember({ agentId: "codex", sessionId: "three", sourcePid: 3 });
  assert.equal(store.get("codex", "two"), null);
  assert.equal(store.get("codex", "one").sourcePid, 1);
  now = 121;
  assert.equal(store.get("codex", "one"), null);
  assert.equal(store.get("codex", "three"), null);
});
