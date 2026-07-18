"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDecisionOutput,
  noDecisionOutput,
  sanitizeDecisionOutput,
} = require("../src/codex-output");

test("builds exact Codex allow and deny outputs", () => {
  assert.deepEqual(JSON.parse(buildDecisionOutput("allow")), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  assert.deepEqual(JSON.parse(buildDecisionOutput("deny", "No")), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "No" } },
  });
  assert.equal(buildDecisionOutput("later"), noDecisionOutput());
});

test("sanitizer strips unsupported fields and fails open", () => {
  const raw = JSON.stringify({
    interrupt: true,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", message: "ignored", updatedInput: { danger: true } },
    },
  });
  assert.deepEqual(JSON.parse(sanitizeDecisionOutput(raw)), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  assert.equal(sanitizeDecisionOutput("bad"), "{}");
  assert.equal(sanitizeDecisionOutput({ hookSpecificOutput: { decision: { behavior: "ask" } } }), "{}");
});
