"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CompletionStore } = require("../src/completion-store");

function fixture() {
  const timers = [];
  const store = new CompletionStore({
    timeoutMs: 8000,
    setTimeout: callback => {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
  });
  return { store, timers };
}

test("completion auto closes after eight-second timer", () => {
  const { store, timers } = fixture();
  store.show({ sessionId: "s1", title: "Done", output: "answer" });
  assert.equal(store.snapshot().title, "Done");
  timers[0].callback();
  assert.equal(store.snapshot(), null);
});

test("expanded completion persists and prompt clears only matching session", () => {
  const { store, timers } = fixture();
  const item = store.show({ sessionId: "s1", title: "Done", output: "answer" });
  assert.equal(store.expand(item.id), true);
  assert.equal(timers[0].cleared, true);
  assert.equal(store.snapshot().expanded, true);
  assert.equal(store.clear("prompt", "other"), false);
  assert.equal(store.clear("prompt", "s1"), true);
});

test("completion kind is restricted to task or plan", () => {
  const { store } = fixture();
  store.show({ sessionId: "plan", completionKind: "plan" });
  assert.equal(store.snapshot().completionKind, "plan");
  store.show({ sessionId: "other", completionKind: "unsafe" });
  assert.equal(store.snapshot().completionKind, "task");
});
