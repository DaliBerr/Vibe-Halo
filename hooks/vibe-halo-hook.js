#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SERVER_ID = "vibe-halo";
const SERVER_HEADER = "x-vibe-halo";
const TOKEN_HEADER = "x-vibe-halo-token";
const RUNTIME_PATH = path.join(process.env.VIBE_HALO_RUNTIME_DIR || path.join(os.homedir(), ".vibe-halo"), "runtime.json");
const PERMISSION_TIMEOUT_MS = 130_000;
const EVENT_TIMEOUT_MS = 2_000;
const STDIN_LIMIT = 1024 * 1024;
const AGENT_IDS = new Set([
  "codex", "zcode", "qwen-code", "copilot-cli", "claude-code", "codebuddy",
  "gemini-cli", "antigravity", "cursor-agent", "kiro", "kimi-code", "codewhale",
  "qoder", "qoderwork", "reasonix",
]);
const PASSIVE_PERMISSION_AGENTS = new Set(["kimi-code", "qoder", "qoderwork"]);

function parseAgentId(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--agent");
  const value = index >= 0 ? cleanText(argv[index + 1], 80).toLowerCase() : "codex";
  return AGENT_IDS.has(value) ? value : "codex";
}

function parseEventArg(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--event");
  return index >= 0 ? cleanText(argv[index + 1], 80) : "";
}

function noDecisionOutput(agentId = "codex") {
  return ["copilot-cli", "claude-code", "codebuddy"].includes(agentId) ? "" : "{}";
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRuntime() {
  try {
    const value = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
    if (value?.app !== SERVER_ID) return null;
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
    if (!Number.isInteger(value.ownerPid) || !processAlive(value.ownerPid)) return null;
    if (typeof value.token !== "string" || value.token.length < 32) return null;
    return value;
  } catch {
    return null;
  }
}

function readStdinJson() {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };
    process.stdin.on("data", chunk => {
      size += chunk.length;
      if (size > STDIN_LIMIT) return finish(null);
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { finish(null); }
    });
    process.stdin.on("error", () => finish(null));
  });
}

function cleanText(value, max = 2000) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function normalizeToolInput(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") return cleanText(value, 4000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 32).map(item => normalizeToolInput(item, depth + 1));
  if (typeof value !== "object") return null;
  const out = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    out[cleanText(key, 120)] = normalizeToolInput(value[key], depth + 1);
  }
  return out;
}

function readSessionMeta(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return {};
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(256 * 1024);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    for (const line of buffer.subarray(0, count).toString("utf8").split(/\r?\n/)) {
      try {
        const item = JSON.parse(line);
        if (item?.type === "session_meta" && item.payload && typeof item.payload === "object") return item.payload;
      } catch {}
    }
  } catch {}
  return {};
}

function classifyRole(payload, meta) {
  const raw = cleanText(
    payload?.codex_session_role || payload?.agent_role || payload?.agent_type ||
    meta?.agent_role || meta?.agent_type,
    80
  ).toLowerCase();
  if (!raw || raw === "root" || raw === "main" || raw === "primary") return "main";
  return "subagent";
}

function collectPidChain() {
  const fallback = { sourcePid: process.ppid || null, pidChain: process.ppid ? [process.ppid] : [] };
  if (process.platform !== "win32" || !process.ppid) return fallback;
  const script = [
    "Add-Type @'",
    "using System;",
    "using System.Diagnostics;",
    "using System.Runtime.InteropServices;",
    "public static class IslandParentPid {",
    "  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2_0; public IntPtr Reserved2_1; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }",
    "  [DllImport(\"ntdll.dll\")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int l, out int r);",
    "  public static int Get(int pid) { try { using (var p = Process.GetProcessById(pid)) { var i = new PBI(); int r; return NtQueryInformationProcess(p.Handle, 0, ref i, Marshal.SizeOf(i), out r) == 0 ? i.InheritedFromUniqueProcessId.ToInt32() : 0; } } catch { return 0; } }",
    "}",
    "'@",
    `$current = ${Number(process.ppid)}`,
    "$items = @()",
    "for ($i = 0; $i -lt 20 -and $current -gt 0; $i++) {",
    "  $items += [int]$current",
    "  $parent = [IslandParentPid]::Get([int]$current)",
    "  if ($parent -le 0 -or $parent -eq $current) { break }",
    "  $current = [int]$parent",
    "}",
    "$items | ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 1200,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout.trim()) return fallback;
    const raw = JSON.parse(result.stdout.trim());
    const rows = Array.isArray(raw) ? raw : [raw];
    const chain = rows.map(Number).filter(pid => Number.isInteger(pid) && pid > 0);
    return { sourcePid: chain[0] || fallback.sourcePid, pidChain: chain.slice(0, 20) };
  } catch {
    return fallback;
  }
}

function normalizeSessionId(payload, agentId = "codex") {
  const raw = cleanText(payload?.session_id || payload?.sessionId || payload?.conversation_id || payload?.conversationId, 240);
  if (raw) return raw.startsWith(`${agentId}:`) ? raw : `${agentId}:${raw}`;
  const transcript = cleanText(payload?.transcript_path, 2000);
  return transcript ? `${agentId}:${crypto.createHash("sha1").update(transcript).digest("hex").slice(0, 20)}` : `${agentId}:unknown`;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(block => typeof block === "string" ? block : cleanText(block?.text, 6000)).filter(Boolean).join("\n\n");
}

function extractAssistantOutput(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  try {
    const stat = fs.statSync(transcriptPath);
    const size = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    fs.closeSync(fd);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      let item;
      try { item = JSON.parse(lines[i]); } catch { continue; }
      const payload = item?.payload;
      if (item?.type === "event_msg" && payload?.type === "agent_message") {
        return cleanText(payload.message || payload.text || textFromContent(payload.content), 6000);
      }
      if (item?.type === "response_item" && payload?.role === "assistant") {
        return cleanText(payload.text || payload.output_text || textFromContent(payload.content), 6000);
      }
    }
  } catch {}
  return "";
}

function normalizeEvent(payload) {
  const raw = cleanText(payload?.hook_event_name || payload?.hookEventName || payload?.event || payload?.type, 80);
  const compact = raw.toLowerCase().replace(/[.\-\s]/g, "");
  if (["permissionrequest", "pretooluse", "permission_request", "permission"].includes(compact)) return "PermissionRequest";
  if (["elicitation", "clarify", "askuserquestion"].includes(compact)) return "Elicitation";
  if (["stop", "sessionend", "session_end", "taskcomplete", "agentstop", "afteragent", "postinvocation", "agent_end"].includes(compact)) return "Stop";
  if (["userpromptsubmit", "userpromptsubmitted", "message_submit", "beforesubmitprompt", "beforeagent", "sessionstart", "preinvocation"].includes(compact)) return "UserPromptSubmit";
  return raw;
}

function buildBody(payload, agentId = "codex") {
  let event = normalizeEvent(payload);
  const rawToolName = cleanText(payload?.tool_name || payload?.toolName || payload?.tool?.name, 160);
  if (event === "PermissionRequest" && rawToolName === "AskUserQuestion" && ["claude-code", "codebuddy"].includes(agentId)) {
    event = "Elicitation";
  }
  if (!["PermissionRequest", "Elicitation", "Stop", "UserPromptSubmit"].includes(event)) return null;
  const meta = readSessionMeta(payload?.transcript_path);
  const processMeta = collectPidChain();
  const body = {
    event,
    agent_id: agentId,
    session_id: normalizeSessionId(payload, agentId),
    cwd: cleanText(payload?.cwd || payload?.working_directory || payload?.workingDirectory, 2000),
    transcript_path: cleanText(payload?.transcript_path, 4000),
    codex_session_role: classifyRole(payload, meta),
    source_pid: processMeta.sourcePid,
    pid_chain: processMeta.pidChain,
  };
  if (event === "PermissionRequest" || event === "Elicitation") {
    const input = normalizeToolInput(payload?.tool_input || payload?.toolInput || payload?.input || payload?.arguments) || {};
    body.tool_name = rawToolName || (event === "Elicitation" ? "Elicitation" : "Unknown");
    body.tool_input = input;
    body.tool_input_description = cleanText(payload?.tool_input_description || input.description, 1000);
    body.tool_use_id = cleanText(payload?.tool_use_id || payload?.toolUseId || payload?.request_id || payload?.requestId, 240);
    body.request_id = cleanText(payload?.request_id || payload?.requestId || body.tool_use_id, 240);
    if (event === "Elicitation" || (agentId === "zcode" && rawToolName === "AskUserQuestion")) {
      body.questions = Array.isArray(input.questions) ? input.questions : [];
    }
    const permissionSuggestions = payload?.permission_suggestions || payload?.permissionSuggestions;
    if (Array.isArray(permissionSuggestions)) {
      body.permission_suggestions = permissionSuggestions.slice(0, 20)
        .map(item => normalizeToolInput(item))
        .filter(item => item && typeof item === "object" && !Array.isArray(item));
    }
    if (payload?.always === true || payload?.allow_always === true) body.always = true;
    body.tool_input_fingerprint = crypto.createHash("sha256").update(stableStringify(input)).digest("hex");
  } else if (event === "Stop") {
    body.assistant_last_output = extractAssistantOutput(payload?.transcript_path);
    body.session_title = cleanText(meta?.thread_name || meta?.title, 240);
  }
  return body;
}

function post(runtime, endpoint, body, timeoutMs) {
  return new Promise(resolve => {
    const json = JSON.stringify(body);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.request({
      hostname: "127.0.0.1",
      port: runtime.port,
      path: endpoint,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(json),
        [TOKEN_HEADER]: runtime.token,
      },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        const trusted = response.headers[SERVER_HEADER] === SERVER_ID;
        finish({ ok: trusted && response.statusCode >= 200 && response.statusCode < 300, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", () => finish({ ok: false, body: "" }));
    request.end(json);
  });
}

function sanitizePermissionResponse(raw, agentId = "codex") {
  if (!raw && ["copilot-cli", "claude-code", "codebuddy"].includes(agentId)) return "";
  try {
    const parsed = JSON.parse(raw);
    if (agentId === "copilot-cli") {
      if (!parsed || !["allow", "deny"].includes(parsed.behavior)) return "";
      const output = { behavior: parsed.behavior };
      if (parsed.behavior === "deny" && typeof parsed.message === "string") output.message = cleanText(parsed.message, 500);
      return JSON.stringify(output);
    }
    const decision = parsed?.hookSpecificOutput?.hookEventName === "PermissionRequest"
      || parsed?.hookSpecificOutput?.hookEventName === "Elicitation"
      ? parsed.hookSpecificOutput.decision
      : null;
    if (!decision || !["allow", "deny"].includes(decision.behavior)) return noDecisionOutput(agentId);
    const safe = { behavior: decision.behavior };
    if (decision.behavior === "deny" && typeof decision.message === "string") {
      safe.message = cleanText(decision.message, 500);
    }
    if (["zcode", "claude-code", "codebuddy"].includes(agentId) && decision.behavior === "allow") {
      if (decision.updatedInput && typeof decision.updatedInput === "object") safe.updatedInput = normalizeToolInput(decision.updatedInput);
    }
    if (["claude-code", "codebuddy"].includes(agentId) && decision.behavior === "allow") {
      if (Array.isArray(decision.updatedPermissions)) safe.updatedPermissions = decision.updatedPermissions.slice(0, 20).map(item => normalizeToolInput(item));
    }
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: parsed.hookSpecificOutput.hookEventName === "Elicitation" ? "Elicitation" : "PermissionRequest",
      decision: safe,
    } });
  } catch {
    return noDecisionOutput(agentId);
  }
}

async function run(payload, options = {}) {
  const agentId = options.agentId || "codex";
  const event = normalizeEvent(payload);
  if (!["PermissionRequest", "Elicitation", "Stop", "UserPromptSubmit"].includes(event)) return "";
  const runtime = readRuntime();
  const permissionLike = (event === "PermissionRequest" || event === "Elicitation") && !PASSIVE_PERMISSION_AGENTS.has(agentId);
  if (!runtime) return permissionLike ? noDecisionOutput(agentId) : "";
  const body = buildBody(payload, agentId);
  if (!body) return permissionLike ? noDecisionOutput(agentId) : "";
  const endpoint = (body.event === "PermissionRequest" || body.event === "Elicitation") && !PASSIVE_PERMISSION_AGENTS.has(agentId)
    ? "/permission"
    : "/event";
  const result = await post(runtime, endpoint, body, endpoint === "/permission" ? PERMISSION_TIMEOUT_MS : EVENT_TIMEOUT_MS);
  if (endpoint !== "/permission") return "";
  return result.ok ? sanitizePermissionResponse(result.body, agentId) : noDecisionOutput(agentId);
}

async function main() {
  const agentId = parseAgentId();
  const payload = await readStdinJson() || {};
  const event = parseEventArg();
  if (event && !payload.hook_event_name && !payload.hookEventName && !payload.event) payload.hook_event_name = event;
  const output = await run(payload, { agentId });
  if (output) process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main().then(() => process.exit(0), () => {
    const output = noDecisionOutput(parseAgentId());
    if (output) process.stdout.write(`${output}\n`);
    process.exit(0);
  });
}

module.exports = {
  buildBody,
  classifyRole,
  extractAssistantOutput,
  normalizeSessionId,
  normalizeEvent,
  normalizeToolInput,
  parseAgentId,
  parseEventArg,
  sanitizePermissionResponse,
  run,
};
