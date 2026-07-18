"use strict";

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

function formatApprovalInput(toolInput, description = "") {
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
  let label = "工具参数";
  let copyLabel = "复制内容";
  if (command && selected === command) { kind = "command"; label = "命令"; copyLabel = "复制命令"; }
  else if (patch && selected === patch) { kind = "patch"; label = "补丁"; copyLabel = "复制补丁"; }
  else if (query && selected === query) { kind = "query"; label = "查询"; }
  else if (prompt && selected === prompt) { kind = "prompt"; label = "提示"; }
  else if (url && selected === url) { kind = "url"; label = "网址"; }
  else if (filePath && selected === filePath) { kind = "path"; label = "路径"; }
  else if (generic && selected === generic) { kind = "text"; label = "输入"; }

  const raw = safeJson(input);
  const primary = selected?.value
    || "此工具包含结构化参数，请展开“查看完整参数”进行审阅。";
  const metadata = [];
  const chosenKey = selected?.key;
  const cwd = metadataItem("工作目录", input.cwd || input.workdir);
  if (cwd && chosenKey !== "cwd" && chosenKey !== "workdir") metadata.push(cwd);
  const pathValue = metadataItem("路径", input.file_path || input.path);
  if (pathValue && chosenKey !== "file_path" && chosenKey !== "path") metadata.push(pathValue);
  const urlValue = metadataItem("网址", input.url || input.uri);
  if (urlValue && chosenKey !== "url" && chosenKey !== "uri") metadata.push(urlValue);
  if (Number.isFinite(input.timeout_ms)) metadata.push({ label: "超时", value: `${Math.max(0, Math.floor(input.timeout_ms))} ms` });
  const extraDescription = cleanLine(input.description || input.justification, 1000);
  if (extraDescription && extraDescription !== cleanLine(description, 1000)) {
    metadata.push({ label: "说明", value: extraDescription });
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
