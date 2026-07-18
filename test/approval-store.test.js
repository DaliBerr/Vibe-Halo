"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalStore } = require("../src/approval-store");

function fixture() {
  const timers = [];
  let nextId = 1;
  const store = new ApprovalStore({
    timeoutMs: 120_000,
    createId: () => `id-${nextId++}`,
    now: () => 1000,
    setTimeout: callback => {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
  });
  return { store, timers };
}

function request(overrides = {}) {
  return {
    sessionId: "codex:s1",
    toolUseId: "tool-1",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    cwd: "C:\\repo",
    ...overrides,
  };
}

function waiter(outputs) {
  return { complete: output => outputs.push(output) };
}

test("keeps FIFO order and requires explicit id", () => {
  const { store } = fixture();
  const first = [];
  const second = [];
  store.enqueue(request(), waiter(first));
  store.enqueue(request({ toolUseId: "tool-2", toolName: "Write" }), waiter(second));
  assert.equal(store.size, 2);
  assert.equal(store.current.id, "id-1");
  assert.equal(store.resolve("missing", "allow"), false);
  assert.equal(store.resolve("id-1", "allow"), true);
  assert.equal(JSON.parse(first[0]).hookSpecificOutput.decision.behavior, "allow");
  assert.equal(store.current.id, "id-2");
  assert.equal(store.resolve("id-1", "deny"), false);
});

test("deduplicates identical requests and fans out one decision", () => {
  const { store } = fixture();
  const left = [];
  const right = [];
  assert.equal(store.enqueue(request(), waiter(left)).duplicate, false);
  assert.equal(store.enqueue(request(), waiter(right)).duplicate, true);
  assert.equal(store.size, 1);
  store.resolve("id-1", "deny");
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.equal(JSON.parse(left[0]).hookSpecificOutput.decision.behavior, "deny");
});

test("expires to no-decision after the configured timer", () => {
  const { store, timers } = fixture();
  const outputs = [];
  store.enqueue(request(), waiter(outputs));
  timers[0].callback();
  assert.deepEqual(outputs, ["{}"]);
  assert.equal(store.size, 0);
});

test("only removes a request after all duplicate connections disconnect", () => {
  const { store } = fixture();
  const first = waiter([]);
  const second = waiter([]);
  const entry = store.enqueue(request(), first).entry;
  store.enqueue(request(), second);
  assert.equal(store.disconnect(entry.id, first), true);
  assert.equal(store.size, 1);
  assert.equal(store.disconnect(entry.id, second), true);
  assert.equal(store.size, 0);
});
