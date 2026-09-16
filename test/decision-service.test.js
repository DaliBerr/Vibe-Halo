"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalStore } = require("../src/approval-store");
const { DecisionService } = require("../src/decision-service");
const { normalizeRequest, encodeDecision, validateAnswers } = require("../src/agent-registry");
const { IslandController } = require("../src/island-controller");
const { EventEmitter } = require("node:events");

function fixture() {
  let time = 1000;
  const store = new ApprovalStore({ now: () => time, setTimeout: () => null });
  const service = new DecisionService({ approvalStore: store });
  const outputs = [];
  const add = (agentId = "codex", data = {}) => {
    const request = normalizeRequest(agentId, {
      event: "PermissionRequest", request_id: `r${store.size}`, tool_name: "Bash", tool_input: {}, ...data,
    });
    const waiter = { complete: decision => outputs.push({ decision, wire: encodeDecision(agentId, decision, request) }) };
    return { entry: store.enqueue(request, waiter).entry, waiter };
  };
  return { store, service, outputs, add, tick: value => { time = value; } };
}

test("user decisions enforce FIFO and the first winner cannot resolve the next item", () => {
  const { store, service, outputs, add } = fixture();
  const first = add().entry;
  const second = add().entry;
  assert.equal(service.decideLocal({ approvalId: second.id, optionId: "allow" }).status, "not_current");
  assert.equal(outputs.length, 0);
  assert.equal(service.decideLocal({ approvalId: first.id, optionId: "allow" }).status, "desktop_accepted");
  assert.equal(service.decideLocal({ approvalId: first.id, optionId: "deny" }).accepted, false);
  assert.equal(store.current.id, second.id);
  assert.equal(outputs.length, 1);
});

test("elapsed deadlines reject approval before the timer callback runs", () => {
  const { store, service, outputs, add, tick } = fixture();
  const entry = add().entry;
  tick(entry.createdAt + 120_000);
  assert.equal(service.decideLocal({ approvalId: entry.id, optionId: "allow" }).status, "expired");
  assert.equal(outputs.length, 0);
  assert.equal(store.size, 1);
  store.expire(entry.id);
  assert.deepEqual(outputs[0].decision, { optionId: "native" });
});

test("native winner disconnection leaves no stale decision and explicit close stays fail-open", () => {
  const { store, service, outputs, add } = fixture();
  const first = add("zcode");
  const second = add("zcode").entry;
  store.disconnect(first.entry.id, first.waiter);
  assert.equal(service.decideLocal({ approvalId: first.entry.id, optionId: "allow" }).accepted, false);
  assert.equal(service.returnToNative(first.entry.id), false);
  assert.equal(service.returnToNative(second.id), true);
  assert.equal(outputs[0].wire, "{}");
});

test("strict forms reject malformed answers without finalizing the request", () => {
  const { store, service, outputs, add } = fixture();
  const entry = add("zcode", { tool_name: "AskUserQuestion", tool_input: { questions: [
    { id: "q", question: "选择", allowText: false, options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }] },
  ] } }).entry;
  const invalid = [undefined, null, [], {}, { q: [] }, { q: ["a", "b"] }, { q: "甲" }, { q: "unknown" },
    { q: " a " }, { q: "a", extra: "b" }, { q: 1 }, { q: "a".repeat(2001) },
    Object.assign(Object.create({ inherited: true }), { q: "a" }),
    JSON.parse('{"q":"a","__proto__":{}}')];
  for (const answers of invalid) {
    assert.equal(service.decideLocal({ approvalId: entry.id, optionId: "submit", answers }).status, "invalid_answers");
    assert.equal(store.current.id, entry.id);
    assert.equal(outputs.length, 0);
  }
  assert.equal(service.decideLocal({ approvalId: entry.id, optionId: "submit", answers: { q: "b" } }).accepted, true);
  assert.deepEqual(JSON.parse(outputs[0].wire).hookSpecificOutput.decision.updatedInput.answers, { "选择": "乙" });
});

test("multi-select rejects duplicates and free text preserves the existing codec normalization", () => {
  const questions = [{ id: "q", multiSelect: true, allowText: true }];
  assert.equal(validateAnswers(questions, { q: ["a", "a"] }), null);
  assert.equal(validateAnswers(questions, { q: ["a", " a "] }), null);
  assert.deepEqual(validateAnswers(questions, { q: ["中文🚀", "line\nbreak"] }), { q: ["中文🚀", "line break"] });
  const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`q${i}`, "a"]));
  assert.equal(validateAnswers(Object.keys(many).slice(0, 10).map(id => ({ id })), many), null);
  for (const id of ["constructor", "prototype", "__proto__"]) {
    assert.equal(validateAnswers([{ id }], JSON.parse(`{"${id}":"a"}`)), null);
  }
});

test("unknown actions and injected fields cannot produce native or allow", () => {
  const { service, outputs, add } = fixture();
  const entry = add("opencode").entry;
  for (const payload of [
    { approvalId: entry.id, optionId: "allow" },
    { approvalId: entry.id, optionId: "always" },
    { approvalId: entry.id, behavior: "allow" },
    { approvalId: entry.id, optionId: "once", toolInput: { command: "injected" } },
    { approvalId: entry.id, optionId: "native", answers: {} },
  ]) assert.equal(service.decideLocal(payload).accepted, false);
  assert.equal(outputs.length, 0);
  assert.equal(service.decideLocal({ approvalId: entry.id, optionId: "once" }).accepted, true);
  assert.deepEqual(JSON.parse(outputs[0].wire), { decision: "once" });
});

test("real island IPC retains sender validation and uses the shared deadline gate", () => {
  const { store, add, tick, outputs } = fixture();
  const entry = add().entry;
  const ipcMain = new EventEmitter();
  const controller = new IslandController({
    approvalStore: store, ipcMain, screen: new EventEmitter(), nativeTheme: new EventEmitter(),
    inputRequestStore: new EventEmitter(), completionStore: new EventEmitter(),
  });
  const sender = {};
  controller.window = { webContents: sender, isDestroyed: () => false };
  controller.refresh = () => {};
  controller.bind();
  const payload = { approvalId: entry.id, optionId: "allow" };
  ipcMain.emit("island:decision", { sender: {} }, payload);
  assert.equal(outputs.length, 0);
  tick(entry.createdAt + 120_000);
  ipcMain.emit("island:decision", { sender }, payload);
  assert.equal(outputs.length, 0);
  ipcMain.emit("island:close", { sender }, { id: entry.id });
  assert.deepEqual(outputs[0].decision, { optionId: "native", message: "" });
  controller.disposers.forEach(dispose => dispose());
});
