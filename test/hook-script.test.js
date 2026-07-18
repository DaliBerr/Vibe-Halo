"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBody,
  classifyRole,
  normalizeSessionId,
  parseAgentId,
  parseEventArg,
  sanitizePermissionResponse,
} = require("../hooks/vibe-halo-hook");

test("builds a bounded PermissionRequest body", () => {
  const body = buildBody({
    hook_event_name: "PermissionRequest",
    session_id: "s1",
    cwd: "C:\\repo",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "npm test", ignored: "x".repeat(5000) },
  });
  assert.equal(body.event, "PermissionRequest");
  assert.equal(body.session_id, "codex:s1");
  assert.equal(body.tool_name, "Bash");
  assert.equal(body.tool_input.ignored.length, 4000);
  assert.match(body.tool_input_fingerprint, /^[a-f0-9]{64}$/);
});

test("normalizes generic client argv and payload fields", () => {
  assert.equal(parseAgentId(["--agent", "zcode", "--event", "PermissionRequest"]), "zcode");
  assert.equal(parseAgentId(["--agent", "unknown"]), "codex");
  assert.equal(parseEventArg(["--agent", "zcode", "--event", "Stop"]), "Stop");
  const body = buildBody({
    hookEventName: "PermissionRequest", sessionId: "s", requestId: "r", toolName: "Shell", toolInput: { command: "dir" },
    permissionSuggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  }, "claude-code");
  assert.equal(body.agent_id, "claude-code");
  assert.equal(body.session_id, "claude-code:s");
  assert.equal(body.request_id, "r");
  assert.deepEqual(body.permission_suggestions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
});

test("sanitizes client-specific stdout without inventing decisions", () => {
  assert.equal(sanitizePermissionResponse('{"behavior":"allow","extra":true}', "copilot-cli"), '{"behavior":"allow"}');
  assert.equal(sanitizePermissionResponse("{}", "copilot-cli"), "");
  const claude = sanitizePermissionResponse(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      decision: { behavior: "allow", updatedInput: { answers: { Pick: "A" } }, unsafe: true },
    },
  }), "claude-code");
  assert.deepEqual(JSON.parse(claude), {
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      decision: { behavior: "allow", updatedInput: { answers: { Pick: "A" } } },
    },
  });
  const permission = sanitizePermissionResponse(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] },
    },
  }), "claude-code");
  assert.deepEqual(JSON.parse(permission).hookSpecificOutput.decision.updatedPermissions, [
    { type: "setMode", mode: "acceptEdits" },
  ]);
  assert.equal(sanitizePermissionResponse("invalid", "claude-code"), "");
});

test("classifies non-root roles as subagents", () => {
  assert.equal(classifyRole({}, {}), "main");
  assert.equal(classifyRole({ agent_role: "root" }, {}), "main");
  assert.equal(classifyRole({}, { agent_type: "worker" }), "subagent");
});

test("normalizes fallback sessions and sanitizes server response", () => {
  assert.equal(normalizeSessionId({ session_id: "abc" }), "codex:abc");
  assert.match(normalizeSessionId({ transcript_path: "C:\\rollout.jsonl" }), /^codex:[a-f0-9]{20}$/);
  const raw = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "No", extra: true } } });
  assert.deepEqual(JSON.parse(sanitizePermissionResponse(raw)), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "No" } },
  });
  assert.equal(sanitizePermissionResponse("invalid"), "{}");
});
