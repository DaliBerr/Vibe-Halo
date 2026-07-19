"use strict";

const { translate } = require("./i18n");

const MAX_PRIMARY_LENGTH = 10_000;
const MAX_RAW_LENGTH = 10_000;

function cleanText(value, max = MAX_PRIMARY_LENGTH) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function cleanLine(value, max = 2000) {
  return cleanText(value, max).replace(/\s+/g, " ");
}

function safeJson(value) {
  try { return JSON.stringify(value && typeof value === "object" ? value : {}, null, 2).slice(0, MAX_RAW_LENGTH); }
  catch { return "{}"; }
}

function firstText(input, keys) {
  for (const key of keys) {
    const value = cleanText(input[key]);
    if (value) return { key, value };
  }
  return null;
}

function metadataItem(label, value) {
  const text = cleanLine(value);
  return text ? { label, value: text } : null;
}

function formatApprovalInput(toolInput, description = "", translator = null) {
  const t = typeof translator === "function" ? translator : (key, params) => translate("en-US", key, params);
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {};
  const command = firstText(input, ["command", "cmd", "script"]);
  const patch = firstText(input, ["patch", "diff"]);
  const query = firstText(input, ["query", "search_query"]);
  const prompt = firstText(input, ["prompt", "question"]);
  const url = firstText(input, ["url", "uri"]);
  const filePath = firstText(input, ["file_path", "path"]);
  const generic = firstText(input, ["input", "text"]);
  const selected = command || patch || query || prompt || url || filePath || generic;

  let kind = "structured";
  let label = t("presentation.toolParameters");
  let copyLabel = t("renderer.copyContent");
  if (command && selected === command) { kind = "command"; label = t("presentation.command"); copyLabel = t("renderer.copyCommand"); }
  else if (patch && selected === patch) { kind = "patch"; label = t("presentation.patch"); copyLabel = t("renderer.copyPatch"); }
  else if (query && selected === query) { kind = "query"; label = t("presentation.query"); }
  else if (prompt && selected === prompt) { kind = "prompt"; label = t("presentation.prompt"); }
  else if (url && selected === url) { kind = "url"; label = t("presentation.url"); }
  else if (filePath && selected === filePath) { kind = "path"; label = t("presentation.path"); }
  else if (generic && selected === generic) { kind = "text"; label = t("presentation.input"); }

  const raw = safeJson(input);
  const primary = selected?.value
    || t("presentation.structuredFallback");
  const metadata = [];
  const chosenKey = selected?.key;
  const cwd = metadataItem(t("presentation.workingDirectory"), input.cwd || input.workdir);
  if (cwd && chosenKey !== "cwd" && chosenKey !== "workdir") metadata.push(cwd);
  const pathValue = metadataItem(t("presentation.path"), input.file_path || input.path);
  if (pathValue && chosenKey !== "file_path" && chosenKey !== "path") metadata.push(pathValue);
  const urlValue = metadataItem(t("presentation.url"), input.url || input.uri);
  if (urlValue && chosenKey !== "url" && chosenKey !== "uri") metadata.push(urlValue);
  if (Number.isFinite(input.timeout_ms)) metadata.push({ label: t("presentation.timeout"), value: `${Math.max(0, Math.floor(input.timeout_ms))} ms` });
  const extraDescription = cleanLine(input.description || input.justification, 1000);
  if (extraDescription && extraDescription !== cleanLine(description, 1000)) {
    metadata.push({ label: t("presentation.description"), value: extraDescription });
  }

  return {
    kind,
    label,
    primary,
    copyLabel,
    copyText: selected?.value || raw,
    metadata: metadata.slice(0, 6),
    raw,
    hasRaw: raw !== "{}",
  };
}

module.exports = { cleanLine, cleanText, formatApprovalInput, safeJson };
