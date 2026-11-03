"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { once } = require("node:events");
const { ApprovalStore } = require("../src/approval-store");
const { IslandServer } = require("../src/server");
const { DecisionService } = require("../src/decision-service");
const { normalizeRequest, encodeDecision, validateAnswers } = require("../src/agent-registry");
const { IntegrationManager } = require("../src/integration-manager");
const { formAnswer } = require("../src/renderer/question-submit");
const { detail } = require("../src/remote/event-projector");
const { displayAnswers } = require("../src/history-events");
const plugin = import(pathToFileURL(path.resolve(__dirname, "../hooks/integrations/deepseek-harness/index.mjs")));

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-dsh-"));
  const runtimePath = path.join(dir, "runtime.json");
  const approvals = new ApprovalStore({ timeoutMs: 10000 });
  const events = [];
  const server = new IslandServer({ approvalStore: approvals, runtimePath, onEvent: e => events.push(e) });
  await server.start();
  const ctx = new EventEmitter();
  const agent = { id: "session", session: { id: "session", header: { cwd: dir } }, ctx: { workingDirectory: { cwd: dir } } };
  (await plugin).apply(ctx, { runtimePath });
  const call = (name, req, next = () => "native") => {
    const event = { agent, ...req };
    return ctx.listeners(name)[0](event, () => next(event));
  };
  t.after(async () => { ctx.emit("dispose"); await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ctx, call, agent, approvals, events, dir, server, runtimePath };
}

const questions = [
  { id: "original id", question: "选一项", options: [{ label: "选项 A" }, { label: "选项 B" }] },
  { id: "multi", question: "多选", multiSelect: true, options: [{ label: "甲" }, { label: "乙" }], detail: "第一行\n第二行" },
  { id: "free", question: "文字回答" },
];

test("DSH maps multi-question/multi-select/custom/skip answers exactly without label collisions", async () => {
  const p = await plugin, form = p.questionForm(questions);
  assert.equal(form[1].detail, "第一行\n第二行");
  const values = { q_1: formAnswer(form[0], ["option_1"], "option_2"),
    q_2: formAnswer(form[1], ["option_2"], "自定义\n文字"), q_3: formAnswer(form[2], [], "") };
  assert.deepEqual(p.decodeAnswers(questions, form, validateAnswers(form, values)), { answers: [
    { id: "original id", selected: [], custom: "option_2" },
    { id: "multi", selected: ["乙"], custom: "自定义\n文字" }, { id: "free", selected: [] },
  ] });
  assert.equal(validateAnswers(form, { ...values, q_1: "unoffered" }), null);
  assert.equal(p.decodeAnswers(questions, form, { ...values, q_2: ["option_1", "option_1"] }), null);
  assert.equal(p.questionForm([{ ...questions[0], options: [{ label: "x".repeat(241) }] }]), null);
  assert.equal(p.questionForm([questions[0], questions[0]]), null);
  const full = [{ id: "all", question: "全选并补充", multiSelect: true, options: Array.from({ length: 20 }, (_, i) => ({ label: `选项${i}` })) }];
  const fullForm = p.questionForm(full);
  const fullValue = { q_1: formAnswer(fullForm[0], fullForm[0].options.map(o => o.id), "补充文字") };
  const fullAnswer = p.decodeAnswers(full, fullForm, validateAnswers(fullForm, fullValue));
  assert.equal(fullAnswer.answers[0].selected.length, 20);
  assert.equal(fullAnswer.answers[0].custom, "补充文字");
});

test("DSH real HTTP approval FIFO, explicit allow/deny, native fallback, and cancellation", async t => {
  const f = await fixture(t);
  const aReady = once(f.approvals, "changed");
  const a = f.call("approval/request", { toolName: "bash", reason: "sandbox escalation" });
  await aReady;
  const first = f.approvals.current.id;
  const bReady = once(f.approvals, "changed");
  const b = f.call("approval/request", { toolName: "write" });
  await bReady;
  const decisions = new DecisionService({ approvalStore: f.approvals });
  assert.equal(decisions.decideLocal({ approvalId: f.approvals.entries[1].id, optionId: "allow" }).accepted, false);
  assert.equal(decisions.decideLocal({ approvalId: first, optionId: "allow" }).accepted, true);
  assert.equal(await a, "allowed-once");
  decisions.decideLocal({ approvalId: f.approvals.current.id, optionId: "deny" });
  assert.equal(await b, "rejected");
  const ready = once(f.approvals, "changed");
  const native = f.call("approval/request", { toolName: "bash" });
  await ready; decisions.returnToNative(f.approvals.current.id);
  assert.equal(await native, "native");
  const controller = new AbortController(), enqueued = once(f.approvals, "changed");
  const cancelled = f.call("approval/request", { toolName: "bash", signal: controller.signal });
  await enqueued; const id = f.approvals.current.id; const gone = once(f.approvals, "changed"); controller.abort();
  assert.equal(await cancelled, "native"); await gone;
  assert.equal(f.approvals.size, 0);
  assert.equal(decisions.decideLocal({ approvalId: id, optionId: "allow" }).accepted, false);
});

test("DSH structured answers travel through the shared server, store and remote detail", async t => {
  const f = await fixture(t), ready = once(f.approvals, "changed");
  const response = f.call("user-questions/request", { questions });
  await ready;
  const entry = f.approvals.current;
  assert.equal(entry.kind, "elicitation");
  const view = detail(entry, { pcId: "pc", pcSessionEpoch: f.approvals.pcSessionEpoch, currentId: entry.id, pendingCount: 1, now: Date.now() });
  assert.equal(view.remoteActionable, true);
  assert.equal(view.questions[1].detail, questions[1].detail);
  assert.equal(view.questions[1].answerFormat, "dsh");
  const display = require("../src/island-controller").IslandController.prototype.localizeEntry.call({ localization: { t: (_key, params) => params?.agentName || "" } }, {
    agentId: "deepseek-harness", agentName: "DeepSeek Harness", title: "", titleKey: "fallback.completionTitle", titleParams: { agentName: "DeepSeek Harness" },
  });
  assert.equal(display.agentName, "DSH");
  assert.equal(display.title, "DSH");
  const decisions = new DecisionService({ approvalStore: f.approvals });
  assert.equal(decisions.decideLocal({ approvalId: entry.id, optionId: "submit", answers: { q_1: "option_1", q_2: ["option_1", "text:附加"], q_3: "text:option_1" } }).accepted, true);
  assert.deepEqual(await response, { answers: [
    { id: "original id", selected: ["选项 A"] }, { id: "multi", selected: ["甲"], custom: "附加" }, { id: "free", selected: [], custom: "option_1" },
  ] });
});

test("DSH plan review keeps full multiline details and exact labels", async t => {
  const f = await fixture(t), ready = once(f.approvals, "changed");
  const plan = "完整计划\n".repeat(900);
  const q = { id: "plan", question: "审阅计划", detail: plan,
    options: [{ label: "按计划执行" }, { label: "继续修改" }], intent: { kind: "plan-review", approve: "按计划执行" } };
  const result = f.call("user-questions/request", { questions: [q] });
  await ready; const entry = f.approvals.current;
  assert.equal(entry.toolName, "PlanReview");
  assert.equal(entry.questions[0].detail, plan);
  const view = detail(entry, { pcId: "pc", pcSessionEpoch: f.approvals.pcSessionEpoch, currentId: entry.id, pendingCount: 1, now: Date.now() });
  assert.equal(view.remoteActionable, true);
  assert.equal(view.questions[0].detail, plan);
  new DecisionService({ approvalStore: f.approvals }).decideLocal({ approvalId: entry.id, optionId: "submit", answers: { q_1: "option_2" } });
  assert.deepEqual(await result, { answers: [{ id: "plan", selected: ["继续修改"] }] });
});

test("DSH plugin reload restores only continued questions from the public session projection", async t => {
  const f = await fixture(t);
  f.ctx.sessionProjections = { snapshot: () => ({ values: { userQuestions: { active: [
    { callId: "open", state: "open", questions: [questions[0]] },
    { callId: "continued", state: "continued", questions: [questions[0]] },
  ] } } }) };
  let answered;
  f.ctx.userQuestions = { answer: (_agent, id, value) => { answered = { id, value }; return true; } };
  const ready = once(f.approvals, "changed"); f.ctx.emit("agent/created", { agent: f.agent });
  await ready;
  assert.equal(f.approvals.size, 1);
  new DecisionService({ approvalStore: f.approvals }).decideLocal({ approvalId: f.approvals.current.id, optionId: "submit", answers: { q_1: "option_1" } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(answered.id, "continued");
});

test("DSH approval-intent only offers declared grants, with persistent scope gated remotely", async t => {
  const f = await fixture(t), ready = once(f.approvals, "changed");
  const q = { id: "permission", question: "允许访问？", detail: "完整访问范围", options: [{ label: "这次" }, { label: "拒绝" }, { label: "以后也允许" }], intent: { kind: "approval", approve: "这次", reject: "拒绝", always: "以后也允许" } };
  const response = f.call("user-questions/request", { questions: [q] });
  await ready;
  const entry = f.approvals.current;
  const view = detail(entry, { pcId: "pc", pcSessionEpoch: f.approvals.pcSessionEpoch, currentId: entry.id, pendingCount: 1, now: Date.now() });
  assert.equal(view.options.some(o => o.id === "always"), false);
  assert.match(entry.persistentPreviews.always, /完整访问范围/);
  new DecisionService({ approvalStore: f.approvals }).decideLocal({ approvalId: entry.id, optionId: "always" });
  assert.deepEqual(await response, { answers: [{ id: "permission", selected: ["以后也允许"] }] });
  const plain = normalizeRequest("deepseek-harness", { event: "PermissionRequest", tool_input: {} });
  assert.equal(encodeDecision("deepseek-harness", { optionId: "always" }, plain), "{}");
});

test("DSH missing app and oversized question delegate without granting", async t => {
  const f = await fixture(t);
  fs.unlinkSync(f.runtimePath);
  assert.equal(await f.call("approval/request", { toolName: "bash" }), "native");
  assert.equal(await f.call("user-questions/request", { questions: Array(11).fill(questions[0]) }), "native");
});

test("DSH rejects unknown action names even when they name inherited object properties", async t => {
  const f = await fixture(t);
  f.server.handle = (_req, res) => {
    res.writeHead(200, { "x-vibe-halo": "vibe-halo", "content-type": "application/json" });
    res.end('{"decision":"constructor"}');
  };
  const q = { id: "p", question: "允许？", detail: "测试范围", options: [{ label: "是" }, { label: "否" }], intent: { kind: "approval", approve: "是", reject: "否" } };
  assert.equal(await f.call("user-questions/request", { questions: [q] }), "native");
  assert.equal(await f.call("approval/request", { toolName: "bash" }), "native");
});

test("DSH expires and unloads requests without granting, and ignores invalid question decisions", async t => {
  const f = await fixture(t);
  let ready = once(f.approvals, "changed");
  const expired = f.call("approval/request", { toolName: "bash" });
  await ready; f.approvals.expire(f.approvals.current.id);
  assert.equal(await expired, "native");
  ready = once(f.approvals, "changed");
  const invalid = f.call("user-questions/request", { questions });
  await ready;
  // Even a compromised/buggy caller cannot turn a question into an allow grant.
  f.approvals.finalize(f.approvals.current, "resolved", { optionId: "allow" }, "fixture", true);
  assert.equal(await invalid, "native");
  ready = once(f.approvals, "changed");
  const unloaded = f.call("approval/request", { toolName: "bash" });
  await ready; const gone = once(f.approvals, "changed"); f.ctx.emit("dispose");
  assert.equal(await unloaded, "native"); await gone;
  assert.equal(f.approvals.size, 0);
});

test("DSH continued timed answers use the owning late-reply method and native answers withdraw the island", async t => {
  const f = await fixture(t), controller = new AbortController();
  const q = [{ id: "late-q", question: "稍后回答", options: [{ label: "甲" }] }];
  const firstReady = once(f.approvals, "changed");
  const first = f.call("user-questions/request", { questions: q, signal: controller.signal, wait: { callId: "timed", timed: true } });
  await firstReady; const gone = once(f.approvals, "changed"); controller.abort();
  await assert.rejects(first, { name: "AbortError" }); await gone;
  let reply;
  f.ctx.userQuestions = { answer: (agent, callId, answer) => { reply = { agent, callId, answer }; return true; } };
  const lateReady = once(f.approvals, "changed");
  f.ctx.emit("session/event", f.agent.session, { type: "tool/result", data: { message: { toolCallId: "timed", content: [{ type: "text", text: '{"pending":true,"callId":"timed"}' }] } } });
  await lateReady;
  new DecisionService({ approvalStore: f.approvals }).decideLocal({ approvalId: f.approvals.current.id, optionId: "submit", answers: { q_1: "option_1" } });
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(reply.callId, "timed");
  assert.equal(reply.agent, f.agent);
  assert.deepEqual(reply.answer, { answers: [{ id: "late-q", selected: ["甲"] }] });
  const another = once(f.approvals, "changed");
  f.ctx.emit("session/event", f.agent.session, { type: "tool/result", data: { message: { toolCallId: "timed", content: [{ type: "text", text: '{"pending":true}' }] } } });
  await another; const withdrawn = once(f.approvals, "changed");
  f.ctx.emit("session/event", f.agent.session, { type: "user/message", data: { source: { kind: "user-question-reply", callId: "timed" } } });
  await withdrawn; assert.equal(f.approvals.size, 0);
});

test("DSH completion follows committed successful turns, never every idle, cancellation or failure", async t => {
  const f = await fixture(t);
  const emit = (type, data) => f.ctx.emit("session/event", f.agent.session, { type, data });
  emit("turn/start", { turn: 1 });
  emit("assistant/message", { content: [{ type: "text", text: "验收完成" }] });
  emit("turn/end", { reason: { kind: "completed" } });
  emit("turn/end", { reason: { kind: "error" } });
  emit("turn/end", { reason: { kind: "aborted" } });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(f.events.map(e => e.event), ["UserPromptSubmit", "Stop"]);
  assert.equal(f.events[1].assistant_last_output, "验收完成");
});

test("DSH install is idempotent, preserves profiles, backs up once and removes only managed rows", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-dsh-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const name of ["desktop", "web"]) {
    const dir = path.join(home, ".dsh/profiles", name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), '{"private":true}');
    fs.writeFileSync(path.join(dir, "cordis.patch.yml"), name === "web" ? "# comment\n[]\n" : "# other plugin\n- id: third-party\n  config: {keep: true}\n");
  }
  const m = new IntegrationManager({ homeDir: home, dshHome: path.join(home, ".dsh"), hookScriptPath: __filename });
  assert.equal(m.install("deepseek-harness").ok, true);
  assert.equal(m.install("deepseek-harness").changed, false);
  assert.equal(m.status("deepseek-harness").healthy, true);
  const patch = m.paths("deepseek-harness")[0];
  assert.match(fs.readFileSync(patch, "utf8"), /third-party/);
  fs.appendFileSync(patch, "\n- id: vibe-halo-dsh\n  disabled: true\n");
  assert.throws(() => m.install("deepseek-harness"), /user-override/);
  assert.equal(m.status("deepseek-harness").disabled, true);
  m.uninstall("deepseek-harness");
  assert.match(fs.readFileSync(patch, "utf8"), /third-party/);
  assert.match(fs.readFileSync(patch, "utf8"), /disabled: true/);
  assert.doesNotMatch(fs.readFileSync(patch, "utf8"), />>> Vibe Halo/);
});
