"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBody,
  classifyRole,
  normalizeSessionId,
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
