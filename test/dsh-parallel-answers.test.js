"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { EventEmitter, once } = require("node:events");
const { ApprovalStore } = require("../src/approval-store");
const { IslandServer } = require("../src/server");
const { DecisionService } = require("../src/decision-service");
const plugin = import(pathToFileURL(path.resolve(__dirname, "../hooks/integrations/deepseek-harness/index.mjs")));
const questions = [{ id: "q", question: "选择", options: [{ label: "甲" }, { label: "乙" }] }];
const chosen = label => ({ answers: [{ id: "q", selected: [label] }] });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };

async function fixture(t, timeoutMs = 3000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-dsh-parallel-"));
  const runtimePath = path.join(dir, "runtime.json");
  const store = new ApprovalStore({ timeoutMs });
  const server = new IslandServer({ approvalStore: store, runtimePath });
  await server.start();
  const ctx = new EventEmitter();
  (await plugin).apply(ctx, { runtimePath });
  const agent = { id: "s", session: { id: "s", header: {} } };
  const parent = new AbortController();
  const request = { agent, questions, signal: parent.signal };
  const native = deferred(); let nativeSignal, calls = 0;
  const next = () => {
    calls++; nativeSignal = request.signal;
    nativeSignal.addEventListener("abort", () => native.reject(Object.assign(new Error("native withdrawn"), { code: "ASK_ABORTED" })), { once: true });
    return native.promise;
  };
  const start = () => ctx.listeners("user-questions/request")[0](request, next);
  const decisions = new DecisionService({ approvalStore: store });
  t.after(async () => { parent.abort(); ctx.emit("dispose"); await server.stop(); fs.rmSync(dir, { force: true, recursive: true }); });
  return { ctx, dir, runtimePath, store, server, parent, request, native, start, decisions, nativeSignal: () => nativeSignal, calls: () => calls };
}

test("DSH native and island questions open together; native-first answer withdraws island", async t => {
  const f = await fixture(t), ready = once(f.store, "changed");
  const result = f.start(); await ready;
  assert.equal(f.calls(), 1); assert.notEqual(f.nativeSignal(), f.parent.signal);
  const id = f.store.current.id, gone = once(f.store, "changed");
  f.native.resolve(chosen("乙"));
  assert.deepEqual(await result, chosen("乙")); await gone;
  assert.equal(f.store.size, 0); assert.equal(f.parent.signal.aborted, false);
  assert.equal(f.decisions.decideLocal({ approvalId: id, optionId: "submit", answers: { q_1: "option_1" } }).accepted, false);
});

test("DSH island-first answer cancels only the native card, not the parent Turn", async t => {
  const f = await fixture(t), ready = once(f.store, "changed");
  const result = f.start(); await ready;
  f.decisions.decideLocal({ approvalId: f.store.current.id, optionId: "submit", answers: { q_1: "option_1" } });
  assert.deepEqual(await result, chosen("甲"));
  assert.equal(f.nativeSignal().aborted, true); assert.equal(f.parent.signal.aborted, false);
  assert.equal(f.calls(), 1); f.native.resolve(chosen("乙"));
});

test("DSH close of island keeps the already-open native question usable", async t => {
  const f = await fixture(t), ready = once(f.store, "changed");
  const result = f.start(); await ready;
  f.decisions.returnToNative(f.store.current.id);
  await new Promise(r => setTimeout(r, 15));
  assert.equal(f.nativeSignal().aborted, false); assert.equal(f.calls(), 1);
  f.native.resolve(chosen("乙")); assert.deepEqual(await result, chosen("乙"));
});

test("DSH island expiry keeps native usable and an immediate native answer leaves no stale island", async t => {
  const f = await fixture(t, 80), ready = once(f.store, "changed");
  const result = f.start(); await ready;
  await once(f.store, "changed");
  assert.equal(f.store.size, 0); assert.equal(f.nativeSignal().aborted, false);
  f.native.resolve(chosen("乙")); assert.deepEqual(await result, chosen("乙"));
  const immediate = f.start();
  assert.deepEqual(await immediate, chosen("乙"));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(f.store.size, 0); assert.equal(f.parent.signal.aborted, false);
});

test("DSH no native provider still permits an island answer; offline island leaves native intact", async t => {
  const f = await fixture(t), ready = once(f.store, "changed");
  const result = f.start();
  f.native.reject(Object.assign(new Error("no UI"), { code: "NO_PROVIDER" })); await ready;
  f.decisions.decideLocal({ approvalId: f.store.current.id, optionId: "submit", answers: { q_1: "option_1" } });
  assert.deepEqual(await result, chosen("甲"));
  fs.unlinkSync(f.runtimePath);
  const nativeOnly = (await plugin).parallelQuestion({ questions }, () => Promise.resolve(chosen("乙")), async () => undefined);
  assert.deepEqual(await nativeOnly, chosen("乙"));
});

test("DSH parent cancellation and native timeout withdraw the island without an answer", async t => {
  const f = await fixture(t), ready = once(f.store, "changed");
  const result = f.start(); const rejected = assert.rejects(result, { name: "AbortError" }); await ready;
  const gone = once(f.store, "changed"); f.parent.abort(); await rejected; await gone;
  assert.equal(f.store.size, 0); assert.equal(f.nativeSignal().aborted, true);
  const next = deferred();
  const timer = Object.assign(new Error("timed out"), { code: "ASK_TIMED_OUT" });
  let other;
  const timeout = (await plugin).parallelQuestion({ questions }, () => next.promise, signal => {
    other = signal; return new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  });
  await Promise.resolve(); next.reject(timer);
  await assert.rejects(timeout, { code: "ASK_TIMED_OUT" }); assert.equal(other.aborted, true);
});

test("DSH simultaneous answers settle once and immutable future events remain native", async () => {
  const p = await plugin;
  const a = deferred(), b = deferred(), parent = new AbortController();
  const req = { questions, signal: parent.signal };
  let nativeSignal;
  const result = p.parallelQuestion(req, () => { nativeSignal = req.signal; return a.promise; }, () => b.promise);
  await Promise.resolve(); a.resolve(chosen("乙")); b.resolve(chosen("甲"));
  assert.deepEqual(await result, chosen("乙")); assert.equal(parent.signal.aborted, false);
  await Promise.resolve(); assert.equal(req.signal, parent.signal);
  assert.equal(nativeSignal.aborted, false);
  let touched = false;
  assert.deepEqual(await p.parallelQuestion(Object.freeze({ questions }), () => chosen("甲"), async () => { touched = true; }), chosen("甲"));
  assert.equal(touched, false);
});

test("DSH unloading island plugin hands control to the native UI already on screen", async t => {
  const f = await fixture(t), ready = once(f.store, "changed");
  const result = f.start(); await ready; const gone = once(f.store, "changed");
  f.ctx.emit("dispose"); await gone;
  assert.equal(f.nativeSignal().aborted, false);
  f.native.resolve(chosen("甲")); assert.deepEqual(await result, chosen("甲"));
});
