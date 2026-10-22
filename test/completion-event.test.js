"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { completionFromStop, permissionMode } = require("../src/completion-event");

const codex = { id: "codex", name: "Codex" };

test("completion titles preserve chat names through localization and remote delivery", () => {
  for (const permission_mode of ["default", "plan"]) {
    for (const cwd of ["", "C:/Users/test/Documents/c-users-test-desktop-document-student"]) {
      const completion = completionFromStop({ event: "Stop", session_title: " 查找报告撰写模板 ", cwd, permission_mode }, codex, "codex:report");
      assert.equal(completion.title, "查找报告撰写模板");
      assert.equal(completion.titleKey, "");
      assert.equal(completion.completionKind, permission_mode === "plan" ? "plan" : "task");
    }
  }
  const fallback = completionFromStop({ event: "Stop", cwd: "/repo/demo" }, codex, "codex:report");
  assert.equal(fallback.title, "demo");
  assert.equal(fallback.titleKey, "");
  assert.equal(completionFromStop({ event: "Stop" }, codex, "codex:report").titleKey, "fallback.completionTitle");
});

test("Codex follow-up suggestions never become task or plan completion notifications", () => {
  for (const suggestion of ["Next step", "", null, "转义\\\"与换行\n下一步"]) {
    for (const permission_mode of ["default", "plan"]) {
      assert.equal(completionFromStop({ event: "Stop", permission_mode, assistant_last_output: JSON.stringify({ suggestion }) }, codex, "same-session"), null);
    }
  }
  for (const output of ['{"suggestion":"result","count":1}', '```json\n{"suggestion":"example"}\n```', 'The suggestion is ready.', '{"suggestion":42}', '{"suggestion":', '[{"suggestion":"result"}]']) {
    assert.ok(completionFromStop({ event: "Stop", assistant_last_output: output }, codex, "same-session"));
  }
  assert.ok(completionFromStop({ event: "Stop", assistant_last_output: '{"suggestion":"result"}' }, { id: "claude-code", name: "Claude Code" }, "other-client"));
});

test("maps a Codex plan-mode Stop to a dedicated plan-ready completion", () => {
  const completion = completionFromStop({
    event: "Stop",
    permission_mode: "plan",
    cwd: "C:\\Projects\\demo",
    assistant_last_output: "1. Inspect\n2. Implement\n3. Verify",
    source_pid: 42,
    pid_chain: [42, 7],
  }, codex, "codex:plan");

  assert.equal(completion.completionKind, "plan");
  assert.equal(completion.title, "");
  assert.equal(completion.titleKey, "fallback.agentPlanReadyTitle");
  assert.deepEqual(completion.titleParams, { agentName: "Codex" });
  assert.equal(completion.outputKey, "");
  assert.equal(completion.output, "1. Inspect\n2. Implement\n3. Verify");
});

test("plan-ready detection supports Codex and ZCode and rejects unknown permission modes", () => {
  assert.equal(permissionMode("plan"), "plan");
  assert.equal(permissionMode("unsafe"), "");
  assert.equal(completionFromStop({ event: "Stop", permissionMode: "plan" }, codex, "s").completionKind, "plan");
  const zcode = completionFromStop({ event: "Stop", permission_mode: "plan", cwd: "/repo" }, { id: "zcode", name: "ZCode" }, "s");
  assert.equal(zcode.completionKind, "plan");
  assert.equal(zcode.titleKey, "fallback.agentPlanReadyTitle");
  assert.deepEqual(zcode.titleParams, { agentName: "ZCode" });
  const qwen = completionFromStop({ event: "Stop", permission_mode: "plan", cwd: "/repo" }, { id: "qwen-code", name: "Qwen Code" }, "s");
  assert.equal(qwen.completionKind, "task");
  assert.equal(completionFromStop({ event: "UserPromptSubmit" }, codex, "s"), null);
});

test("plan-ready completion remains useful when transcript output is unavailable", () => {
  const completion = completionFromStop({ event: "Stop", permission_mode: "plan" }, codex, "codex:plan");
  assert.equal(completion.completionKind, "plan");
  assert.equal(completion.output, "");
  assert.equal(completion.outputKey, "fallback.agentPlanReadyContent");
  assert.deepEqual(completion.outputParams, { agentName: "Codex" });
});
