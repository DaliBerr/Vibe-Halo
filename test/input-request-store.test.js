"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { InputRequestStore } = require("../src/input-request-store");

function fixture() {
  const timers = [];
  const store = new InputRequestStore({
    timeoutMs: 30_000,
    setTimeout: callback => {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
  });
  return { store, timers };
}

test("input reminders are deduplicated and displayed FIFO", () => {
  const { store } = fixture();
  const first = store.enqueue({ requestKey: "file-a::call-1", sessionId: "s1", title: "选择一" });
  const duplicate = store.enqueue({ requestKey: "file-a::call-1", sessionId: "s1", title: "重复" });
  const second = store.enqueue({ requestKey: "file-b::call-2", sessionId: "s2", title: "选择二" });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(second.duplicate, false);
  assert.equal(store.snapshot().pendingCount, 2);
  assert.equal(store.snapshot().current.title, "选择一");
  assert.equal(Object.hasOwn(store.snapshot().current, "requestKey"), false);

  assert.equal(store.resolve("file-a::call-1"), true);
  assert.equal(store.snapshot().current.title, "选择二");
});

test("dismiss only hides the local reminder and timeout advances the queue", () => {
  const { store, timers } = fixture();
  const first = store.enqueue({ requestKey: "one", title: "First" }).entry;
  store.enqueue({ requestKey: "two", title: "Second" });

  assert.equal(store.dismiss(first.id), true);
  assert.equal(timers[0].cleared, true);
  assert.equal(store.snapshot().current.title, "Second");
  timers[1].callback();
  assert.equal(store.snapshot().current, null);
});

test("only the current reminder can expand or collapse", () => {
  const { store } = fixture();
  const current = store.enqueue({ requestKey: "one" }).entry;
  assert.equal(store.expand("unknown"), false);
  assert.equal(store.expand(current.id), true);
  assert.equal(store.snapshot().current.expanded, true);
  assert.equal(store.collapse(current.id), true);
  assert.equal(store.snapshot().current.expanded, false);
});

test("session lifecycle only clears matching reminders", () => {
  const { store } = fixture();
  store.enqueue({ requestKey: "one", sessionId: "s1" });
  store.enqueue({ requestKey: "two", sessionId: "s2" });
  assert.equal(store.clearSession("unknown"), false);
  assert.equal(store.clearSession("s1", "new-prompt"), true);
  assert.equal(store.snapshot().pendingCount, 1);
  assert.equal(store.snapshot().current.sessionId, "s2");
});

test("keeps bounded structured questions for the native-like reminder layout", () => {
  const { store } = fixture();
  store.enqueue({
    requestKey: "question",
    questions: [{
      header: "测试",
      id: "choice",
      question: "看到了什么？",
      options: [{ label: "提醒", description: "顶部提醒" }],
    }],
  });
  const current = store.snapshot().current;
  assert.equal(current.questions.length, 1);
  assert.equal(current.questions[0].options[0].label, "提醒");
});

test("emits finalized reminder details and parsed native answers", () => {
  const { store } = fixture();
  const finalized = [];
  store.on("finalized", value => finalized.push(value));
  store.enqueue({ requestKey: "question", content: "Pick one", questions: [{ id: "choice", question: "Pick" }] });
  assert.equal(store.resolve("question", { answers: { choice: "A" }, answerAvailable: true }), true);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].entry.content, "Pick one");
  assert.deepEqual(finalized[0].answers, { choice: "A" });
  assert.equal(finalized[0].answerAvailable, true);
});
