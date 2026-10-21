"use strict";

const { agent } = require("../agent-registry");
const { sanitizeValue } = require("../history-store");

function snippet(value, limit) {
  if (typeof value !== "string") return "";
  const text = sanitizeValue(value, "content")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/!\[[^\]]*\]\([^\n]*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^\n]*?\)/g, "$1")
    .replace(/^[ \t]*[:#>*-]+[ \t]*/gm, "")
    .replace(/[`*_]|[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : text;
}

function notificationPreview(value) {
  const kind = value.summary.kind;
  let text = value.toolInputText || "";
  if (kind === "approval") {
    try {
      const input = JSON.parse(text);
      text = input.description || input.command || input.file_path || input.path || "";
    } catch { text = ""; }
    text = [value.toolName, value.description || text].filter(Boolean).join(" · ");
  } else if (kind === "question" || kind === "input") {
    text = value.questions?.[0]?.question || value.description || text;
  }
  return {
    agent: snippet(agent(value.summary.agentId)?.name || value.summary.agentId, 40),
    context: ["completion", "plan"].includes(kind) ? snippet(value.description, 60) : "",
    text: snippet(text, 160),
  };
}

module.exports = { notificationPreview };
