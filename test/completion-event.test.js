"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { completionFromStop, permissionMode } = require("../src/completion-event");

const codex = { id: "codex", name: "Codex" };

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
  assert.equal(completion.titleKey, "fallback.planReadyTitle");
  assert.equal(completion.outputKey, "");
  assert.equal(completion.output, "1. Inspect\n2. Implement\n3. Verify");
});

test("plan-ready detection is Codex-only and rejects unknown permission modes", () => {
  assert.equal(permissionMode("plan"), "plan");
  assert.equal(permissionMode("unsafe"), "");
  assert.equal(completionFromStop({ event: "Stop", permissionMode: "plan" }, codex, "s").completionKind, "plan");
  const zcode = completionFromStop({ event: "Stop", permission_mode: "plan", cwd: "/repo" }, { id: "zcode", name: "ZCode" }, "s");
  assert.equal(zcode.completionKind, "task");
  assert.equal(zcode.title, "repo");
  assert.equal(completionFromStop({ event: "UserPromptSubmit" }, codex, "s"), null);
});

test("plan-ready completion remains useful when transcript output is unavailable", () => {
  const completion = completionFromStop({ event: "Stop", permission_mode: "plan" }, codex, "codex:plan");
  assert.equal(completion.completionKind, "plan");
  assert.equal(completion.output, "");
  assert.equal(completion.outputKey, "fallback.planReadyContent");
});
