"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ApprovalStore } = require("../src/approval-store");
const { DecisionService } = require("../src/decision-service");
const { normalizeRequest, encodeDecision } = require("../src/agent-registry");
const { detail, contextDigest, queueView } = require("../src/remote/event-projector");
const { validate, LIMITS } = require("../packages/protocol");

function fixture() {
  let time = Date.parse("2026-09-16T09:00:00.000Z");
  let enabled = true;
  let trusted = true;
  const principal = Object.freeze({ fixture: true });
  const authorization = { pcId: "pc_fixture", mobileId: "mobile_fixture", bindingId: "bind_fixture", bindingRevision: 1,
    scopes: ["approvals.decide", "questions.answer"] };
  const store = new ApprovalStore({ now: () => time, setTimeout: () => null });
  const outputs = [];
  let count = 0;
  const service = new DecisionService({ approvalStore: store, pcId: authorization.pcId,
    remoteControlEnabled: () => enabled,
    authorizeRemote: proof => proof === principal && trusted ? authorization : null,
  });
  const add = (data = {}, agent = "codex") => {
    const request = normalizeRequest(agent, { event: "PermissionRequest", request_id: `r${count++}`,
      tool_name: "Bash", tool_input: { command: "echo synthetic" }, ...data });
    const waiter = { complete: decision => outputs.push(encodeDecision(agent, decision, request)) };
    return { entry: store.enqueue(request, waiter).entry, waiter };
  };
  const intent = entry => ({
    protocolVersion: 1, decisionId: crypto.randomUUID(), bindingId: authorization.bindingId, bindingRevision: 1,
    mobileId: authorization.mobileId, pcId: authorization.pcId, pcSessionEpoch: store.pcSessionEpoch,
    eventId: entry.eventId, approvalId: entry.id, expectedRevision: entry.eventRevision,
    approvalContextDigest: contextDigest(entry), optionId: entry.options[0].id,
    issuedAt: new Date(time).toISOString(), expiresAt: new Date(time + 30_000).toISOString(),
  });
  const view = entry => detail(entry, { pcId: authorization.pcId, pcSessionEpoch: store.pcSessionEpoch,
    currentId: store.current?.id, pendingCount: store.size, now: time });
  return { store, service, outputs, add, intent, view, principal, authorization,
    tick: value => { time = value; }, disable: () => { enabled = false; }, revoke: () => { trusted = false; } };
}

test("network queue summaries whitelist fields and detached pages cannot mutate requests", () => {
  const f = fixture();
  const entry = f.add({ cwd: "C:\\private-project", source_pid: 42, pid_chain: [42], tool_input: { command: "secret command" } }).entry;
  f.add();
  const page = f.store.listPending();
  page.entries[0].toolInput.command = "changed";
  page.entries[0].options[0].id = "deny";
  assert.equal(entry.toolInput.command, "secret command");
  assert.equal(entry.options[0].id, "allow");
  const queue = queueView(f.store, { pcId: "pc_fixture" });
  assert.equal(queue.events.length, 2);
  assert.deepEqual(queue.events.map(event => event.actionable), [true, false]);
  for (const value of ["command", "private-project", "cwd", "sourcePid", "pidChain", "sessionId", "options", "questions", "waiters"]) {
    assert.equal(JSON.stringify(queue).includes(value), false, value);
  }
  assert.ok(queue.events.every(event => validate("eventSummary", event).ok));
  assert.throws(() => f.store.listPending({ limit: 501 }), RangeError);
});

test("event identity survives duplicates; head promotion advances revision but not deadline", () => {
  const f = fixture();
  const first = f.add().entry;
  const second = f.add().entry;
  const old = { eventId: second.eventId, expiresAt: second.expiresAt, revision: second.eventRevision };
  const before = f.store.streamSeq;
  const duplicate = f.store.enqueue({ agentId: "codex", requestId: "r1", toolInput: { command: "echo synthetic" } }, { complete() {} });
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.store.streamSeq, before);
  f.store.emit("changed", f.store.snapshot(), "animation");
  assert.equal(second.eventRevision, old.revision);
  f.service.decideLocal({ approvalId: first.id, optionId: "allow" });
  assert.equal(second.eventId, old.eventId);
  assert.equal(second.expiresAt, old.expiresAt);
  assert.equal(second.eventRevision, old.revision + 1);
  assert.ok(second.streamSeq > first.streamSeq);
});

test("LAN/cloud duplicate simulation resolves once and rejects reused ids with changed content", () => {
  const f = fixture();
  const entry = f.add().entry;
  const intent = f.intent(entry);
  const result = f.service.decideVerifiedRemote(intent, f.principal);
  assert.equal(result.status, "desktop_accepted");
  assert.deepEqual(f.service.decideVerifiedRemote(structuredClone(intent), f.principal), result);
  assert.equal(f.service.decideVerifiedRemote({ ...intent, optionId: "deny" }, f.principal).status, "decision_conflict");
  assert.equal(f.outputs.length, 1);
  assert.equal(JSON.parse(f.outputs[0]).hookSpecificOutput.decision.behavior, "allow");
});

test("remote service is disabled without a local switch and a verified principal", () => {
  const f = fixture();
  const intent = f.intent(f.add().entry);
  const inert = new DecisionService({ approvalStore: f.store, pcId: "pc_fixture" });
  assert.equal(inert.decideVerifiedRemote(intent, f.principal).status, "forbidden");
  assert.equal(f.service.decideVerifiedRemote(intent, {}).status, "forbidden");
  f.disable();
  assert.equal(f.service.decideVerifiedRemote(intent, f.principal).status, "forbidden");
  assert.equal(f.outputs.length, 0);
});

test("stale epoch, revision, context, non-head and delayed timer intents leave waiters intact", () => {
  const f = fixture();
  const first = f.add().entry;
  const second = f.add().entry;
  const patches = [
    [{ pcSessionEpoch: crypto.randomUUID() }, "stale_epoch"],
    [{ expectedRevision: 99 }, "stale_revision"],
    [{ approvalContextDigest: `sha256:${"b".repeat(64)}` }, "stale_context"],
    [{ eventId: "evt_other" }, "stale_revision"],
  ];
  for (const [patch, status] of patches) assert.equal(f.service.decideVerifiedRemote({ ...f.intent(first), ...patch }, f.principal).status, status);
  assert.equal(f.service.decideVerifiedRemote(f.intent(second), f.principal).status, "not_current");
  const expires = f.intent(first);
  f.tick(first.expiresAt);
  assert.equal(f.service.decideVerifiedRemote(expires, f.principal).status, "expired");
  assert.equal(f.outputs.length, 0);
  assert.equal(f.store.size, 2);
});

test("revocation and scope checks apply even when a decision receipt is cached", () => {
  const f = fixture();
  const intent = f.intent(f.add().entry);
  assert.equal(f.service.decideVerifiedRemote(intent, f.principal).accepted, true);
  f.revoke();
  assert.equal(f.service.decideVerifiedRemote(intent, f.principal).status, "forbidden");
  assert.equal(f.outputs.length, 1);
  const other = fixture();
  other.authorization.scopes = ["events.read"];
  assert.equal(other.service.decideVerifiedRemote(other.intent(other.add().entry), other.principal).status, "forbidden");
});

test("cross-PC, mobile and binding revision changes cannot borrow authorization", () => {
  const f = fixture();
  const entry = f.add().entry;
  for (const patch of [{ pcId: "pc_other" }, { mobileId: "mobile_other" }, { bindingId: "bind_other" }, { bindingRevision: 2 }]) {
    assert.equal(f.service.decideVerifiedRemote({ ...f.intent(entry), ...patch }, f.principal).status, "forbidden");
  }
  assert.equal(f.outputs.length, 0);
});

test("persistent options stay unavailable even if a supplied scope claims to permit them", () => {
  const f = fixture();
  const entry = f.add({ always: true }, "opencode").entry;
  f.authorization.scopes.push("approvals.persistent");
  assert.equal(f.view(entry).options.some(option => option.id === "always"), false);
  assert.equal(f.service.decideVerifiedRemote({ ...f.intent(entry), optionId: "always" }, f.principal).status, "forbidden");
  assert.equal(f.service.decideVerifiedRemote(f.intent(entry), f.principal).accepted, true);
  assert.deepEqual(JSON.parse(f.outputs[0]), { decision: "once" });
});

test("remote forms reuse exact PC codecs; illegal closed answers do not finalize", () => {
  const f = fixture();
  const entry = f.add({ tool_name: "AskUserQuestion", tool_input: { questions: [
    { id: "q", question: "选择", allowText: false, options: [{ id: "a", label: "甲" }] },
  ] } }, "zcode").entry;
  assert.equal(f.service.decideVerifiedRemote({ ...f.intent(entry), answers: { q: "unknown" } }, f.principal).status, "invalid_answers");
  assert.equal(f.store.size, 1);
  assert.equal(f.service.decideVerifiedRemote({ ...f.intent(entry), answers: { q: "a" } }, f.principal).accepted, true);
  assert.deepEqual(JSON.parse(f.outputs[0]).hookSpecificOutput.decision.updatedInput.answers, { "选择": "甲" });
});

test("truncated, redacted and oversized detail cannot authorize a remote request", () => {
  for (const data of [
    { tool_input: { command: "x".repeat(4001) } },
    { tool_input: { command: "synthetic", apiToken: "synthetic-secret" } },
    { tool_input: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["field" + i, "中".repeat(2000)])) },
  ]) {
    const f = fixture();
    const entry = f.add(data).entry;
    const view = f.view(entry);
    assert.ok(view);
    assert.equal(view.remoteActionable, false);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) <= LIMITS.detailBytes);
    assert.equal(f.service.decideVerifiedRemote(f.intent(entry), f.principal).status, "detail_incomplete");
    assert.equal(f.outputs.length, 0);
  }
});

test("quiescing refuses remote operations while local shutdown returns every waiter to native", () => {
  const f = fixture();
  const first = f.add().entry;
  f.add();
  f.service.quiesceRemote();
  assert.equal(f.service.decideVerifiedRemote(f.intent(first), f.principal).status, "forbidden");
  assert.equal(f.store.size, 2);
  f.store.shutdown();
  assert.deepEqual(f.outputs, ["{}", "{}"]);
});

test("native-first and local-first races cannot change the next request", () => {
  for (const winner of ["native", "local"]) {
    const f = fixture();
    const first = f.add();
    const second = f.add().entry;
    const intent = f.intent(first.entry);
    if (winner === "native") f.store.disconnect(first.entry.id, first.waiter);
    else f.service.decideLocal({ approvalId: first.entry.id, optionId: "deny" });
    assert.equal(f.service.decideVerifiedRemote(intent, f.principal).accepted, false);
    assert.equal(f.store.current.id, second.id);
  }
});

test("queue pagination is bounded by UTF-8 bytes and resumes on the same watermark", () => {
  const f = fixture();
  for (let i = 0; i < 300; i++) f.add();
  const page = queueView(f.store, { pcId: "pc_fixture", limit: 500 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= LIMITS.detailBytes);
  assert.ok(page.nextOffset > 0 && page.nextOffset < 300);
  const next = queueView(f.store, { pcId: "pc_fixture", offset: page.nextOffset, limit: 500 });
  assert.equal(next.streamSeq, page.streamSeq);
  assert.notEqual(page.events.at(-1).eventId, next.events[0].eventId);
});

test("receipt capacity rejects new work without evicting prior decisions and expires bounded records", () => {
  const f = fixture();
  const entry = f.add().entry;
  const original = f.intent(entry);
  for (let i = 0; i < 500; i++) {
    assert.equal(f.service.decideVerifiedRemote({ ...f.intent(entry), expectedRevision: 99 }, f.principal).status, "stale_revision");
  }
  assert.equal(f.service.receipts.size, 500);
  assert.equal(f.service.decideVerifiedRemote(original, f.principal).status, "capacity_exceeded");
  assert.equal(f.outputs.length, 0);
  f.tick(entry.createdAt + 600_000);
  assert.equal(f.service.decideVerifiedRemote(original, f.principal).status, "expired");
  assert.equal(f.service.receipts.size, 1);
});

test("observer failures return unknown without repeating an already written decision", () => {
  const f = fixture();
  const entry = f.add().entry;
  const intent = f.intent(entry);
  f.store.on("finalized", () => { throw Error("synthetic observer failure"); });
  assert.equal(f.service.decideVerifiedRemote(intent, f.principal).status, "result_unknown");
  assert.equal(f.service.decideVerifiedRemote(intent, f.principal).status, "result_unknown");
  assert.equal(f.outputs.length, 1);
});

test("context completeness handles invalid scalar types and the full 20-option boundary", () => {
  const request = normalizeRequest("codex", { event: "PermissionRequest", tool_name: { toString: 5 }, tool_input: {} });
  assert.equal(request.remoteContextComplete, false);
  const f = fixture();
  const entry = f.add({ tool_name: "AskUserQuestion", tool_input: { questions: [
    { id: "q", question: "Choose", options: Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) },
  ] } }, "zcode").entry;
  assert.equal(f.view(entry).remoteActionable, true);
  assert.equal(f.view(entry).questions[0].options.length, 20);
});
