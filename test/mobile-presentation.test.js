"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { historyView } = require("../src/remote/history-view");
test("device profile names count Unicode characters and reject blank/control names", async () => {
  const { deviceName, checkedProfile } = await import("../packages/protocol/src/device-profile.mjs");
  assert.equal(deviceName("  RETARD  "), "RETARD");
  assert.equal(deviceName("😀".repeat(48)), "😀".repeat(48));
  for (const value of [" ", "x\nx", "x\u202ex", "😀".repeat(49), null]) assert.throws(() => deviceName(value));
  const value = { protocolVersion: 1, deviceId: "pc_a", relayOrigin: "https://relay.test", revision: 1, name: "电脑" };
  assert.equal(checkedProfile(value, "pc_a", value.relayOrigin), value);
  assert.throws(() => checkedProfile(value, "pc_b", value.relayOrigin));
  assert.throws(() => checkedProfile({ ...value, revision: 0 }, "pc_a", value.relayOrigin));
});
test("readable history exports contextual summaries and bounded answers, not raw records", () => {
  const record = { id: "h1", kind: "question", agentId: "codex", agentName: "Codex", title: "等待回答", sessionId: "session-1234",
    cwd: "C:\\Tools\\Clawd-island", createdAt: 1, finalizedAt: 2, outcome: "submit", questions: [{ id: "q1", question: "选择哪种方案？" }],
    answers: { q1: ["方案一"] }, answerAvailable: true, toolInput: { token: "[REDACTED]" } };
  const result = historyView(record, true);
  assert.equal(result.projectName, "Clawd-island"); assert.equal(result.preview, "选择哪种方案？");
  assert.equal(result.finalizedAt, 2); assert.equal(result.questions[0].answer, "方案一");
  assert.equal(result.toolInput, undefined); assert.equal(result.cwd, undefined);
  const plan = historyView({ ...record, kind: "plan", questions: [], content: "中".repeat(5000) }, true);
  assert.ok(Buffer.byteLength(plan.excerpt) <= 2400); assert.equal(plan.truncated, true);
});
