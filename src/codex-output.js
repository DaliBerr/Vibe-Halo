"use strict";

function noDecisionOutput() {
  return "{}";
}

function buildDecisionObject(behavior, message) {
  if (behavior !== "allow" && behavior !== "deny") return {};
  const decision = { behavior };
  if (behavior === "deny" && typeof message === "string" && message.trim()) {
    decision.message = message.trim().slice(0, 500);
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  };
}

function buildDecisionOutput(behavior, message) {
  const value = buildDecisionObject(behavior, message);
  return Object.keys(value).length ? JSON.stringify(value) : noDecisionOutput();
}

function sanitizeDecisionOutput(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return noDecisionOutput();
  }
  const decision = parsed?.hookSpecificOutput?.hookEventName === "PermissionRequest"
    ? parsed.hookSpecificOutput.decision
    : null;
  if (!decision || (decision.behavior !== "allow" && decision.behavior !== "deny")) {
    return noDecisionOutput();
  }
  return buildDecisionOutput(decision.behavior, decision.message);
}

module.exports = {
  noDecisionOutput,
  buildDecisionObject,
  buildDecisionOutput,
  sanitizeDecisionOutput,
};
