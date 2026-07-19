"use strict";

const APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ id: "allow", labelKey: "action.allowOnce", tone: "primary" }),
  Object.freeze({ id: "deny", labelKey: "action.deny", tone: "danger" }),
  Object.freeze({ id: "native", labelKey: "action.handleInClient", tone: "secondary", overflow: true }),
]);

const PASSIVE_OPTIONS = Object.freeze([]);
const EVENT_ALIASES = Object.freeze({
  permissionrequest: "PermissionRequest",
  pretooluse: "PermissionRequest",
  permission_request: "PermissionRequest",
  permission: "PermissionRequest",
  elicitation: "Elicitation",
  clarify: "Elicitation",
  askuserquestion: "Elicitation",
  stop: "Stop",
  sessionend: "Stop",
  session_end: "Stop",
  postinvocation: "Stop",
  afteragent: "Stop",
  agent_end: "Stop",
  taskcomplete: "Stop",
  agentstop: "Stop",
  userpromptsubmit: "UserPromptSubmit",
  userpromptsubmitted: "UserPromptSubmit",
  message_submit: "UserPromptSubmit",
  preinvocation: "UserPromptSubmit",
  beforeagent: "UserPromptSubmit",
  sessionstart: "UserPromptSubmit",
});

function descriptor(id, name, tier, extra = {}) {
  return Object.freeze({
    id,
    name,
    tier,
    capabilities: Object.freeze({
      approval: tier === "approval",
      elicitation: false,
      passiveApproval: tier === "passive",
      completion: true,
      ...extra.capabilities,
    }),
    transport: extra.transport || "command-hook",
    configKind: extra.configKind || "json",
    configHome: extra.configHome || null,
    executableNames: Object.freeze(extra.executableNames || []),
    configPaths: Object.freeze(extra.configPaths || []),
    liveVerification: extra.liveVerification || "contract-only",
    events: Object.freeze(extra.events || ["PermissionRequest", "Stop", "UserPromptSubmit"]),
  });
}

const AGENTS = Object.freeze([
  descriptor("codex", "Codex", "approval", {
    configKind: "codex-toml", configHome: ".codex", executableNames: ["codex.exe", "codex"],
    configPaths: [".codex/config.toml"], liveVerification: "local",
  }),
  descriptor("zcode", "ZCode", "approval", {
    configHome: ".zcode", executableNames: ["ZCode.exe", "zcode"], configPaths: [".zcode/cli/config.json"],
    capabilities: { elicitation: true }, liveVerification: "local",
    events: ["PermissionRequest", "Stop", "UserPromptSubmit", "SessionStart"],
  }),
  descriptor("qwen-code", "Qwen Code", "approval", {
    configHome: ".qwen", executableNames: ["qwen.exe", "qwen"], configPaths: [".qwen/settings.json"],
  }),
  descriptor("copilot-cli", "Copilot CLI", "approval", {
    configHome: ".copilot", executableNames: ["copilot.exe", "copilot"], configPaths: [".copilot/hooks/hooks.json"],
  }),
  descriptor("claude-code", "Claude Code", "approval", {
    configHome: ".claude", executableNames: ["claude.exe", "claude"], configPaths: [".claude/settings.json"],
    capabilities: { elicitation: true }, events: ["PermissionRequest", "Elicitation", "Stop", "UserPromptSubmit"],
  }),
  descriptor("codebuddy", "CodeBuddy", "approval", {
    configHome: ".codebuddy", executableNames: ["codebuddy.exe", "codebuddy"], configPaths: [".codebuddy/settings.json"],
    capabilities: { elicitation: true }, events: ["PermissionRequest", "Elicitation", "Stop", "UserPromptSubmit"],
  }),
  descriptor("hermes", "Hermes", "approval", {
    transport: "python-plugin", configKind: "plugin", configHome: ".hermes",
    executableNames: ["hermes.exe", "hermes"], configPaths: [".hermes/config.yaml"],
    capabilities: { elicitation: true }, events: ["PermissionRequest", "Elicitation", "Stop", "UserPromptSubmit"],
  }),
  descriptor("opencode", "OpenCode", "approval", {
    transport: "reverse-bridge", configKind: "plugin", configHome: ".config/opencode",
    executableNames: ["opencode.exe", "opencode"], configPaths: [".config/opencode/opencode.json", ".config/opencode/opencode.jsonc"],
  }),
  descriptor("kimi-code", "Kimi Code", "passive", {
    configKind: "toml", configHome: ".kimi-code", executableNames: ["kimi.exe", "kimi"],
    configPaths: [".kimi-code/config.toml", ".kimi/config.toml"],
  }),
  descriptor("qoder", "Qoder", "passive", {
    configHome: ".qoder", executableNames: ["qoder.exe", "qoder"], configPaths: [".qoder/settings.json"],
  }),
  descriptor("qoderwork", "QoderWork", "passive", {
    configHome: ".qoderwork", executableNames: ["qoderwork.exe", "qoderwork"], configPaths: [".qoderwork/settings.json"],
  }),
  descriptor("gemini-cli", "Gemini CLI", "status", {
    configHome: ".gemini", executableNames: ["gemini.exe", "gemini"], configPaths: [".gemini/settings.json"],
  }),
  descriptor("antigravity", "Antigravity", "status", {
    configHome: ".gemini", executableNames: ["antigravity.exe", "antigravity"], configPaths: [".gemini/config/hooks.json"],
  }),
  descriptor("cursor-agent", "Cursor Agent", "status", {
    configHome: ".cursor", executableNames: ["cursor-agent.exe", "cursor-agent", "Cursor.exe"],
    configPaths: [".cursor/hooks.json"], liveVerification: "local",
  }),
  descriptor("kiro", "Kiro", "status", {
    configKind: "json-directory", configHome: ".kiro", executableNames: ["kiro.exe", "kiro-cli.exe", "kiro-cli"],
    configPaths: [".kiro/agents"],
  }),
  descriptor("codewhale", "CodeWhale", "status", {
    configKind: "toml", configHome: ".codewhale", executableNames: ["codewhale.exe", "codewhale"],
    configPaths: [".codewhale/config.toml"],
  }),
  descriptor("pi", "Pi", "status", {
    transport: "extension", configKind: "extension", configHome: ".pi", executableNames: ["pi.exe", "pi"],
    configPaths: [".pi/agent/extensions"],
  }),
  descriptor("openclaw", "OpenClaw", "status", {
    transport: "plugin", configKind: "plugin", configHome: ".openclaw", executableNames: ["openclaw.exe", "openclaw"],
    configPaths: [".openclaw/openclaw.json"],
  }),
  descriptor("reasonix", "Reasonix", "status", {
    configHome: "reasonix", executableNames: ["reasonix.exe", "reasonix"], configPaths: ["reasonix/settings.json"],
  }),
]);

const BY_ID = new Map(AGENTS.map(agent => [agent.id, agent]));

function cleanText(value, max = 2000) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function agent(id) {
  return BY_ID.get(cleanText(id, 80).toLowerCase()) || null;
}

function listAgents() {
  return AGENTS.map(value => value);
}

function normalizeEventName(value) {
  const raw = cleanText(value, 80);
  if (!raw) return "";
  return EVENT_ALIASES[raw.toLowerCase().replace(/[.\-\s]/g, "")] || EVENT_ALIASES[raw.toLowerCase()] || raw;
}

function boundedValue(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") return cleanText(value, 4000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 32).map(item => boundedValue(item, depth + 1));
  if (typeof value !== "object") return null;
  const output = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    const safeKey = cleanText(key, 120);
    if (safeKey) output[safeKey] = boundedValue(value[key], depth + 1);
  }
  return output;
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((question, index) => {
    const options = Array.isArray(question?.options) ? question.options.slice(0, 20).map((option, optionIndex) => ({
      id: cleanText(option?.id ?? option?.value, 120) || `option_${optionIndex + 1}`,
      label: cleanText(option?.label ?? option?.name ?? option, 240),
      description: cleanText(option?.description, 600),
    })).filter(option => option.label) : [];
    return {
      id: cleanText(question?.id, 120) || `question_${index + 1}`,
      header: cleanText(question?.header, 120),
      question: cleanText(question?.question ?? question?.prompt ?? question?.text, 1000),
      questionKey: cleanText(question?.question ?? question?.prompt ?? question?.text, 1000)
        ? ""
        : "fallback.agentWaitingInput",
      multiSelect: question?.multiSelect === true || question?.multi_select === true,
      allowText: question?.allowText !== false && question?.allow_text !== false,
      options,
    };
  });
}

function permissionSuggestionDisplay(suggestion, index) {
  if (suggestion.type === "addRules") {
    const toolName = cleanText(suggestion.rules?.[0]?.toolName || suggestion.toolName, 80);
    return toolName
      ? { labelKey: "action.allowToolAlways", labelParams: { toolName } }
      : { labelKey: "action.useLongTermRule" };
  }
  if (suggestion.type === "setMode") {
    const mode = cleanText(suggestion.mode, 80);
    return mode
      ? { labelKey: "action.switchPermissionMode", labelParams: { mode } }
      : { labelKey: "action.switchPermissionModeGeneric" };
  }
  if (suggestion.type === "addDirectories") {
    const count = Array.isArray(suggestion.directories) ? suggestion.directories.length : 0;
    return count
      ? { labelKey: "action.allowDirectories", labelParams: { count } }
      : { labelKey: "action.allowDirectoryAccess" };
  }
  return { labelKey: "action.permissionSuggestion", labelParams: { index: index + 1 } };
}

function normalizePermissionSuggestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(item => boundedValue(item))
    .filter(item => item && typeof item === "object" && !Array.isArray(item)
      && ["addRules", "setMode", "addDirectories"].includes(item.type));
}

function permissionOptions(agentId, data = {}, permissionSuggestions = []) {
  if (agentId === "opencode") {
    const options = [
      { id: "once", labelKey: "action.allowOnce", tone: "primary" },
      ...(data.always === true || data.allow_always === true || data.capabilities?.always === true
        ? [{ id: "always", labelKey: "action.alwaysAllow", tone: "primary", overflow: true }]
        : []),
      { id: "reject", labelKey: "action.deny", tone: "danger" },
      { id: "native", labelKey: "action.handleInClient", tone: "secondary", overflow: true },
    ];
    return options;
  }
  const options = APPROVAL_OPTIONS.map(option => ({ ...option }));
  if (["claude-code", "codebuddy"].includes(agentId)) {
    options.splice(2, 0, ...permissionSuggestions.map((suggestion, index) => ({
      id: `suggestion:${index}`,
      ...permissionSuggestionDisplay(suggestion, index),
      tone: "secondary",
      overflow: true,
    })));
  }
  return options;
}

function normalizeRequest(agentId, data) {
  const descriptorValue = agent(agentId);
  if (!descriptorValue || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const event = normalizeEventName(data.event || data.hook_event_name || data.hookEventName || data.type);
  const rawInput = data.tool_input ?? data.toolInput ?? data.input ?? data.arguments;
  const toolInput = boundedValue(rawInput) || {};
  const requestId = cleanText(data.request_id || data.requestId || data.tool_use_id || data.toolUseId, 240);
  const questions = normalizeQuestions(data.questions || toolInput.questions);
  const permissionSuggestions = normalizePermissionSuggestions(data.permission_suggestions || data.permissionSuggestions);
  const toolName = cleanText(data.tool_name || data.toolName, 160) || (event === "Elicitation" ? "Elicitation" : "Unknown");
  const zcodeQuestion = descriptorValue.id === "zcode"
    && event === "PermissionRequest"
    && toolName === "AskUserQuestion"
    && questions.length > 0;
  const elicitation = (event === "Elicitation" || zcodeQuestion) && descriptorValue.capabilities.elicitation;
  const approval = event === "PermissionRequest" && descriptorValue.capabilities.approval && !zcodeQuestion;
  const passive = event === "PermissionRequest" && descriptorValue.capabilities.passiveApproval;
  return {
    agentId: descriptorValue.id,
    agentName: descriptorValue.name,
    event,
    kind: elicitation ? "elicitation" : (approval ? "approval" : "attention"),
    sessionId: cleanText(data.session_id || data.sessionId, 240) || `${descriptorValue.id}:unknown`,
    requestId,
    toolUseId: cleanText(data.tool_use_id || data.toolUseId, 240),
    fingerprint: cleanText(data.tool_input_fingerprint || data.fingerprint, 128),
    toolName,
    toolInput,
    description: cleanText(data.tool_input_description || data.description || toolInput.description, 1000),
    cwd: cleanText(data.cwd || data.working_directory || data.workingDirectory, 2000),
    sourcePid: positiveInteger(data.source_pid || data.sourcePid),
    pidChain: Array.isArray(data.pid_chain || data.pidChain)
      ? (data.pid_chain || data.pidChain).map(positiveInteger).filter(Boolean).slice(0, 32)
      : [],
    options: approval ? permissionOptions(descriptorValue.id, data, permissionSuggestions) : (elicitation ? [
      { id: "submit", labelKey: "action.submit", tone: "primary" },
      { id: "native", labelKey: "action.handleInClient", tone: "secondary" },
    ] : PASSIVE_OPTIONS),
    questions,
    passive,
    nativeMeta: {
      hookEventName: cleanText(data.hook_event_name || data.hookEventName, 80) || event,
      permissionSuggestions,
    },
  };
}

function validateAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const allowed = new Map((questions || []).map(question => [question.id, question]));
  const output = {};
  for (const [key, raw] of Object.entries(answers).slice(0, 10)) {
    const question = allowed.get(key);
    if (!question) return null;
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 20) return null;
    const cleaned = values.map(value => cleanText(value, 2000)).filter(Boolean);
    if (!cleaned.length) return null;
    output[key] = question.multiSelect ? cleaned : cleaned[0];
  }
  return Object.keys(output).length === allowed.size ? output : null;
}

function encodeDecision(agentId, decision, request = {}) {
  const id = cleanText(decision?.optionId, 80);
  const denyMessage = cleanText(decision?.message, 500) || "Denied in Vibe Halo";
  if (!id || id === "native") return noDecisionOutput(agentId);
  const suggestionMatch = /^(?:suggestion:)(\d+)$/.exec(id);
  if (suggestionMatch && ["claude-code", "codebuddy"].includes(agentId)) {
    const suggestion = request.nativeMeta?.permissionSuggestions?.[Number(suggestionMatch[1])];
    if (!suggestion) return noDecisionOutput(agentId);
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [suggestion] },
    } });
  }
  if (agentId === "opencode") {
    if (!["once", "always", "reject"].includes(id)) return noDecisionOutput(agentId);
    return JSON.stringify({ decision: id });
  }
  if (agentId === "hermes") {
    if (id === "submit") {
      const answers = validateAnswers(request.questions, decision.answers);
      return answers ? JSON.stringify({ decision: "allow", answers }) : noDecisionOutput(agentId);
    }
    if (id !== "allow" && id !== "deny") return noDecisionOutput(agentId);
    return JSON.stringify(id === "deny" ? { decision: "deny", message: denyMessage } : { decision: "allow" });
  }
  if (id === "submit" && agentId === "zcode") {
    const answers = validateAnswers(request.questions, decision.answers);
    if (!answers) return noDecisionOutput(agentId);
    const byQuestion = {};
    for (const question of request.questions || []) {
      const selected = Array.isArray(answers[question.id]) ? answers[question.id] : [answers[question.id]];
      const values = selected.map(value => question.options?.find(option => option.id === value)?.label || value);
      byQuestion[question.question] = values.join(", ");
    }
    const updatedInput = { ...(request.toolInput || {}), answers: byQuestion };
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput },
    } });
  }
  if (id === "submit" && (agentId === "claude-code" || agentId === "codebuddy")) {
    const answers = validateAnswers(request.questions, decision.answers);
    if (!answers) return noDecisionOutput(agentId);
    const byQuestion = {};
    for (const question of request.questions || []) byQuestion[question.question] = answers[question.id];
    const updatedInput = { ...(request.toolInput || {}), answers: byQuestion };
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "Elicitation", decision: { behavior: "allow", updatedInput } } });
  }
  const behavior = id === "allow" ? "allow" : (id === "deny" || id === "reject" ? "deny" : null);
  if (!behavior) return noDecisionOutput(agentId);
  const wireDecision = behavior === "deny" ? { behavior, message: denyMessage } : { behavior };
  if (agentId === "copilot-cli") return JSON.stringify(wireDecision);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: wireDecision } });
}

function noDecisionOutput(agentId) {
  if (agentId === "copilot-cli" || agentId === "claude-code" || agentId === "codebuddy") return "";
  if (agentId === "hermes" || agentId === "opencode") return "";
  return "{}";
}

module.exports = {
  AGENTS,
  agent,
  listAgents,
  normalizeEventName,
  normalizeQuestions,
  normalizeRequest,
  validateAnswers,
  encodeDecision,
  noDecisionOutput,
};
