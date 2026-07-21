"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalStore } = require("../src/approval-store");
const { approvalHistoryRecord, displayAnswers, inputHistoryRecord, planHistoryRecord } = require("../src/history-events");
const { HistoryStore } = require("../src/history-store");

test("maps approval and elicitation finalization without client protocol payloads", () => {
  const approval = approvalHistoryRecord({
    entry: {
      id: "11111111-1111-4111-8111-111111111111",
      type: "approval",
      agentId: "zcode",
      agentName: "ZCode",
      sessionId: "session-1",
      toolName: "Bash",
      description: "Run tests",
      cwd: "/repo",
      toolInput: { command: "npm test" },
      questions: [],
      options: [{ id: "allow", labelKey: "action.allowOnce", labelParams: {}, label: "" }],
      createdAt: 10,
    },
    decision: { optionId: "allow" },
    reason: "allow",
    state: "resolved",
    finalizedAt: 20,
  });
  assert.equal(approval.kind, "approval");
  assert.equal(approval.outcome, "allow");
  assert.equal(approval.outcomeLabelKey, "action.allowOnce");
  assert.deepEqual(approval.toolInput, { command: "npm test" });

  const question = approvalHistoryRecord({
    entry: { ...approval, id: "22222222-2222-4222-8222-222222222222", type: "elicitation", options: [], questions: [{ id: "q", question: "Pick" }] },
    decision: { optionId: "submit", answers: { q: ["one"] } },
    reason: "submit",
    finalizedAt: 30,
  });
  assert.equal(question.kind, "question");
  assert.equal(question.answerAvailable, true);
  assert.deepEqual(question.answers, { q: ["one"] });
});

test("history answers use the visible option label when one is available", () => {
  assert.deepEqual(displayAnswers(
    [{ id: "choice", options: [{ id: "option_1", label: "Keep the side panel" }] }],
    { choice: "option_1", free: "custom answer" },
  ), { choice: "Keep the side panel", free: "custom answer" });
});

test("maps passive and native input results, including unavailable answers", () => {
  const base = {
    entry: {
      id: "33333333-3333-4333-8333-333333333333",
      agentId: "codex",
      agentName: "Codex",
      sessionId: "session-2",
      titleKey: "fallback.codexWaitingChoice",
      titleParams: {},
      contentKey: "fallback.returnToCodex",
      contentParams: {},
      questions: [{ id: "choice", question: "Which?" }],
      cwd: "/repo",
      createdAt: 40,
    },
    finalizedAt: 50,
  };
  const answered = inputHistoryRecord({ ...base, reason: "answered", answers: { choice: ["A"] }, answerAvailable: true });
  assert.equal(answered.outcome, "submit");
  assert.equal(answered.answerAvailable, true);
  const unknown = inputHistoryRecord({ ...base, reason: "answered", answers: {}, answerAvailable: false });
  assert.equal(unknown.outcome, "submit");
  assert.equal(unknown.answerAvailable, false);
});

test("records plans and excludes ordinary task completion notifications", () => {
  const task = { id: "task", completionKind: "task" };
  assert.equal(planHistoryRecord(task), null);
  const plan = planHistoryRecord({
    id: "44444444-4444-4444-8444-444444444444",
    completionKind: "plan",
    agentId: "codex",
    agentName: "Codex",
    sessionId: "session-3",
    titleKey: "fallback.agentPlanReadyTitle",
    titleParams: { agentName: "Codex" },
    output: "1. Make the change",
    outputKey: "",
    outputParams: {},
    cwd: "/repo",
    createdAt: 60,
  });
  assert.equal(plan.kind, "plan");
  assert.equal(plan.content, "1. Make the change");
  assert.equal(plan.outcome, "ready");
});

test("duplicate approval connections produce one finalized history record", () => {
  const approvals = new ApprovalStore({ createId: () => "55555555-5555-4555-8555-555555555555", timeoutMs: 60_000 });
  const history = new HistoryStore({ filePath: "", safeStorage: null });
  history.load();
  approvals.on("finalized", event => history.append(approvalHistoryRecord(event)));
  const request = {
    agentId: "codex", agentName: "Codex", sessionId: "s", requestId: "r",
    toolName: "Shell", toolInput: { command: "echo once" },
  };
  approvals.enqueue(request, { complete() {} });
  approvals.enqueue(request, { complete() {} });
  approvals.resolve("55555555-5555-4555-8555-555555555555", "allow");
  assert.equal(history.snapshot().count, 1);
  assert.equal(history.get("55555555-5555-4555-8555-555555555555").outcome, "allow");
});
