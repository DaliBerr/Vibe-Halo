"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { notificationPreview } = require("../src/remote/notification-preview");

test("watch previews identify clients and summarize completions, tools and questions", () => {
  assert.deepEqual(notificationPreview({ summary: { agentId: "codex", kind: "completion" }, description: "Demo project", toolInputText: "## Fixed **notifications**\n[Details](https://example.invalid)" }),
    { agent: "Codex", context: "Demo project", text: "Fixed notifications Details" });
  assert.deepEqual(notificationPreview({ summary: { agentId: "claude-code", kind: "approval" }, toolName: "Bash", toolInputText: '{"command":"npm test"}' }),
    { agent: "Claude Code", context: "", text: "Bash · npm test" });
  assert.equal(notificationPreview({ summary: { agentId: "codex", kind: "question" }, questions: [{ question: "Which branch?" }] }).text, "Which branch?");
  assert.equal(notificationPreview({ summary: { agentId: "codex", kind: "completion" }, toolInputText: "😀".repeat(200) }).text, "😀".repeat(159) + "…");
  const secret = notificationPreview({ summary: { agentId: "codex", kind: "approval" }, description: "use api_key=supersecretvalue", toolName: "Bash" });
  assert.ok(!secret.text.includes("supersecretvalue"));
  for (const text of ['Authorization: Bearer supersecretvalue', '{"api_key":"supersecretvalue"}']) {
    assert.ok(!notificationPreview({ summary: { agentId: "codex", kind: "completion" }, toolInputText: text }).text.includes("supersecretvalue"));
  }
});
