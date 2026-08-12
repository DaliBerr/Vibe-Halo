"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBody,
  classifyRole,
  normalizeSessionId,
  parseAgentId,
  parseEventArg,
  normalizePermissionMode,
  readCodexTurnApprovalContext,
  sanitizePermissionResponse,
  shouldDeferCodexAutoReview,
} = require("../hooks/vibe-halo-hook");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function turnContext(turnId, approvalsReviewer, approvalPolicy = "on-request") {
  return JSON.stringify({
    type: "turn_context",
    payload: {
      turn_id: turnId,
      approval_policy: approvalPolicy,
      approvals_reviewer: approvalsReviewer,
    },
  });
}

function writeTranscript(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-codex-turn-"));
  roots.push(root);
  const transcriptPath = path.join(root, "rollout.jsonl");
  fs.writeFileSync(transcriptPath, content, "utf8");
  return transcriptPath;
}

function permissionPayload(transcriptPath, turnId) {
  return {
    hook_event_name: "PermissionRequest",
    transcript_path: transcriptPath,
    turn_id: turnId,
    tool_name: "Bash",
    tool_input: { command: "echo test" },
  };
}

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

test("forwards documented permission modes and bounded plan output", () => {
  const plan = buildBody({ hook_event_name: "Stop", session_id: "plan", permission_mode: "plan" });
  assert.equal(plan.permission_mode, "plan");
  const zcodePlan = buildBody({
    hook_event_name: "Stop",
    session_id: "zcode-plan",
    permission_mode: "plan",
    last_assistant_message: "1. Inspect\n2. Implement\n3. Verify",
  }, "zcode");
  assert.equal(zcodePlan.permission_mode, "plan");
  assert.equal(zcodePlan.assistant_last_output, "1. Inspect\n2. Implement\n3. Verify");
  assert.equal(normalizePermissionMode("acceptEdits"), "acceptEdits");
  assert.equal(normalizePermissionMode("unknown"), "");
  const invalid = buildBody({ hook_event_name: "Stop", session_id: "bad", permission_mode: "unknown" });
  assert.equal(Object.hasOwn(invalid, "permission_mode"), false);
});

test("defers only the matching Codex auto-review approval policies", () => {
  const transcriptPath = writeTranscript([
    turnContext("turn-auto", "auto_review"),
    turnContext("turn-granular", "auto_review", { granular: {
      sandbox_approval: true,
      rules: true,
      mcp_elicitations: true,
    } }),
    turnContext("turn-legacy", "guardian_subagent"),
  ].join("\n"));

  assert.equal(shouldDeferCodexAutoReview(permissionPayload(transcriptPath, "turn-auto")), true);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(transcriptPath, "turn-granular")), true);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(transcriptPath, "turn-legacy")), true);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(transcriptPath, "turn-auto"), "zcode"), false);
  assert.equal(shouldDeferCodexAutoReview({
    ...permissionPayload(transcriptPath, "turn-auto"),
    hook_event_name: "Stop",
  }), false);
});

test("never reuses stale auto-review state for a user-reviewed turn", () => {
  const transcriptPath = writeTranscript([
    turnContext("old-turn", "auto_review"),
    turnContext("current-turn", "auto_review"),
    turnContext("current-turn", "user"),
    turnContext("later-turn", "auto_review"),
  ].join("\n"));

  assert.deepEqual(readCodexTurnApprovalContext(transcriptPath, "current-turn"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(transcriptPath, "current-turn")), false);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(transcriptPath, "missing-turn")), false);
});

test("finds a matching turn after a partial tail line and ignores malformed JSON", () => {
  const transcriptPath = writeTranscript([
    "x".repeat(2 * 1024 * 1024),
    "{malformed",
    turnContext("tail-turn", "auto_review"),
    "",
  ].join("\n"));

  assert.equal(shouldDeferCodexAutoReview(permissionPayload(transcriptPath, "tail-turn")), true);
});

test("unknown or out-of-window turn context keeps the existing island flow", () => {
  const outsidePath = writeTranscript([
    turnContext("outside-turn", "auto_review"),
    "x".repeat((2 * 1024 * 1024) + 1024),
  ].join("\n"));
  const partialContext = turnContext("partial-turn", "auto_review");
  const partialPath = writeTranscript(`prefix-without-newline${partialContext}\n${
    "x".repeat((2 * 1024 * 1024) - partialContext.length - 1)
  }`);
  const unknownPolicyPath = writeTranscript(turnContext("unknown-policy", "auto_review", "untrusted"));
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-codex-directory-"));
  roots.push(directoryPath);

  assert.equal(shouldDeferCodexAutoReview(permissionPayload(outsidePath, "outside-turn")), false);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(partialPath, "partial-turn")), false);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(unknownPolicyPath, "unknown-policy")), false);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(directoryPath, "directory-turn")), false);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload("missing.jsonl", "missing-turn")), false);
  assert.equal(shouldDeferCodexAutoReview(permissionPayload(unknownPolicyPath, "")), false);
});

test("keeps bounded ZCode AskUserQuestion fields for native-like rendering", () => {
  const questions = [{ header: "Plan", question: "Pick one?", options: [
    { label: "A", description: "First" }, { label: "B", description: "Second" }, { label: "C", description: "Third" },
  ] }];
  const body = buildBody({
    hook_event_name: "PermissionRequest", session_id: "z", request_id: "zq",
    tool_name: "AskUserQuestion", tool_input: { questions },
  }, "zcode");
  assert.equal(body.event, "PermissionRequest");
  assert.deepEqual(body.questions, questions);
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
  const zcode = sanitizePermissionResponse(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: [], answers: { Pick: "A" } }, unsafe: true },
    },
  }), "zcode");
  assert.deepEqual(JSON.parse(zcode), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: [], answers: { Pick: "A" } } },
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
