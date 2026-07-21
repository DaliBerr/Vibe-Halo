"use strict";

const path = require("path");

const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]);
const PLAN_READY_AGENTS = new Set(["codex", "zcode"]);

function permissionMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  return PERMISSION_MODES.has(mode) ? mode : "";
}

function completionFromStop(data, descriptor, sessionId) {
  if (!data || data.event !== "Stop" || !descriptor) return null;
  const agentId = descriptor.id || "codex";
  const agentName = descriptor.name || "Codex";
  const cwd = typeof data.cwd === "string" ? data.cwd : "";
  const output = typeof data.assistant_last_output === "string" ? data.assistant_last_output : "";
  const planReady = PLAN_READY_AGENTS.has(agentId)
    && permissionMode(data.permission_mode ?? data.permissionMode) === "plan";
  return {
    sessionId,
    agentId,
    agentName,
    completionKind: planReady ? "plan" : "task",
    title: planReady
      ? ""
      : (typeof data.session_title === "string" && data.session_title.trim()
        ? data.session_title.trim()
        : (cwd ? path.basename(cwd) : "")),
    titleKey: planReady ? "fallback.agentPlanReadyTitle" : (cwd ? "" : "fallback.completionTitle"),
    titleParams: { agentName },
    output,
    outputKey: output ? "" : (planReady ? "fallback.agentPlanReadyContent" : "fallback.taskCompleted"),
    outputParams: { agentName },
    cwd,
    sourcePid: Number.isInteger(data.source_pid) ? data.source_pid : null,
    pidChain: Array.isArray(data.pid_chain) ? data.pid_chain : [],
  };
}

module.exports = { PLAN_READY_AGENTS, completionFromStop, permissionMode };
