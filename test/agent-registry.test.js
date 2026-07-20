"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  agent,
  encodeDecision,
  listAgents,
  normalizeRequest,
  validateAnswers,
} = require("../src/agent-registry");

test("registers all 19 bounded client adapters", () => {
  const adapters = listAgents();
  assert.equal(adapters.length, 19);
  assert.equal(new Set(adapters.map(value => value.id)).size, 19);
  assert.equal(new Set(adapters.map(value => value.appearance.glyph)).size, 19);
  assert.equal(new Set(adapters.map(value => value.appearance.accent)).size, 19);
  for (const value of adapters) {
    assert.equal(typeof value.name, "string");
    assert.equal(typeof value.capabilities.completion, "boolean");
    assert.match(value.appearance.glyph, /^.{1,2}$/u);
    assert.match(value.appearance.accent, /^#[0-9A-F]{6}$/);
    assert.match(value.appearance.inkLight, /^#[0-9A-F]{6}$/);
    assert.match(value.appearance.inkDark, /^#[0-9A-F]{6}$/);
    assert.equal(Object.isFrozen(value.appearance), true);
    const request = normalizeRequest(value.id, {
      event: "Stop", session_id: "s", tool_name: "x".repeat(300), tool_input: { value: "y".repeat(5000) },
    });
    assert.equal(request.agentId, value.id);
    assert.equal(request.toolName.length <= 160, true);
    assert.equal(request.toolInput.value.length <= 4000, true);
  }
});

test("declares the requested capability layers", () => {
  for (const id of ["codex", "zcode", "qwen-code", "copilot-cli", "claude-code", "codebuddy", "hermes", "opencode"]) {
    assert.equal(agent(id).capabilities.approval, true, id);
  }
  for (const id of ["zcode", "claude-code", "codebuddy", "hermes"]) assert.equal(agent(id).capabilities.elicitation, true, id);
  for (const id of ["kimi-code", "qoder", "qoderwork"]) assert.equal(agent(id).capabilities.passiveApproval, true, id);
});

test("encodes exact approval wire formats and native fallbacks", () => {
  const request = { questions: [], toolInput: {} };
  for (const id of ["codex", "zcode", "qwen-code"]) {
    assert.deepEqual(JSON.parse(encodeDecision(id, { optionId: "allow" }, request)), {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    assert.equal(encodeDecision(id, { optionId: "native" }, request), "{}");
  }
  assert.deepEqual(JSON.parse(encodeDecision("copilot-cli", { optionId: "deny" }, request)), {
    behavior: "deny", message: "Denied in Vibe Halo",
  });
  assert.equal(encodeDecision("copilot-cli", { optionId: "native" }, request), "");
  assert.deepEqual(JSON.parse(encodeDecision("opencode", { optionId: "always" }, request)), { decision: "always" });
  assert.deepEqual(JSON.parse(encodeDecision("hermes", { optionId: "allow" }, request)), { decision: "allow" });
});

test("only exposes OpenCode always when the native request supports it", () => {
  const base = { event: "PermissionRequest", session_id: "s", request_id: "r", tool_name: "bash", tool_input: {} };
  assert.deepEqual(normalizeRequest("opencode", base).options.map(value => value.id), ["once", "reject", "native"]);
  assert.deepEqual(normalizeRequest("opencode", { ...base, always: true }).options.map(value => value.id), ["once", "always", "reject", "native"]);
});

test("only exposes bounded Claude permission suggestions and returns the exact selected rule", () => {
  const suggestion = {
    type: "addRules", destination: "localSettings", behavior: "allow",
    rules: [{ toolName: "Bash", ruleContent: "npm test" }],
  };
  const request = normalizeRequest("claude-code", {
    event: "PermissionRequest", session_id: "s", request_id: "r", tool_name: "Bash", tool_input: {},
    permission_suggestions: [suggestion, { type: "unknown", secret: "not-rendered" }],
  });
  assert.deepEqual(request.options.map(value => value.id), ["allow", "deny", "suggestion:0", "native"]);
  assert.equal(JSON.stringify(request.options).includes("npm test"), false);
  assert.deepEqual(JSON.parse(encodeDecision("claude-code", { optionId: "suggestion:0" }, request)), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [suggestion] },
    },
  });
  assert.equal(encodeDecision("claude-code", { optionId: "suggestion:9" }, request), "");
  assert.deepEqual(normalizeRequest("qwen-code", {
    event: "PermissionRequest", session_id: "s", request_id: "r", permission_suggestions: [suggestion],
  }).options.map(value => value.id), ["allow", "deny", "native"]);
});

test("validates and encodes Claude and Hermes elicitation answers", () => {
  const normalized = normalizeRequest("claude-code", {
    event: "Elicitation", session_id: "s", request_id: "r", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ id: "q1", question: "Pick", options: [{ id: "a", label: "A" }] }] },
  });
  assert.deepEqual(validateAnswers(normalized.questions, { q1: "a" }), { q1: "a" });
  assert.equal(validateAnswers(normalized.questions, { unknown: "x" }), null);
  const claude = JSON.parse(encodeDecision("claude-code", { optionId: "submit", answers: { q1: "a" } }, normalized));
  assert.equal(claude.hookSpecificOutput.hookEventName, "Elicitation");
  assert.deepEqual(claude.hookSpecificOutput.decision.updatedInput.answers, { Pick: "a" });
  const hermes = JSON.parse(encodeDecision("hermes", { optionId: "submit", answers: { q1: "a" } }, normalized));
  assert.deepEqual(hermes, { decision: "allow", answers: { q1: "a" } });
});

test("presents ZCode AskUserQuestion as an interactive form and returns exact updatedInput", () => {
  const normalized = normalizeRequest("zcode", {
    event: "PermissionRequest", session_id: "z", request_id: "zr", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ header: "方式", question: "请选择实现方式？", options: [
      { label: "直接迁移", description: "复用现有协议" },
      { label: "重新实现", description: "采用新协议" },
      { label: "暂不处理", description: "保持现状" },
    ] }] },
  });
  assert.equal(normalized.kind, "elicitation");
  assert.equal(normalized.options[0].id, "submit");
  assert.deepEqual(normalized.questions[0].options.map(option => option.label), ["直接迁移", "重新实现", "暂不处理"]);
  assert.deepEqual(JSON.parse(encodeDecision("zcode", {
    optionId: "submit", answers: { question_1: "option_2" },
  }, normalized)), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: {
          questions: normalized.toolInput.questions,
          answers: { "请选择实现方式？": "重新实现" },
        },
      },
    },
  });
  assert.equal(encodeDecision("zcode", { optionId: "native" }, normalized), "{}");
});

test("bounds forms to 10 questions and 20 options", () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `q${index}`, question: `Question ${index}`,
    options: Array.from({ length: 25 }, (_value, option) => ({ id: `o${option}`, label: `Option ${option}` })),
  }));
  const request = normalizeRequest("hermes", { event: "Elicitation", session_id: "s", questions, tool_input: { questions } });
  assert.equal(request.questions.length, 10);
  assert.equal(request.questions[0].options.length, 20);
});
