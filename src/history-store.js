"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const HISTORY_VERSION = 1;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const HISTORY_MAX_ENTRIES = 200;
const HISTORY_MAX_RECORD_BYTES = 128 * 1024;
const HISTORY_MAX_FILE_BYTES = 16 * 1024 * 1024;
const HISTORY_VALUE_BUDGET_BYTES = 96 * 1024;
const HISTORY_MAX_NODES = 2048;
const HISTORY_MAX_DEPTH = 8;
const HISTORY_KINDS = new Set(["approval", "question", "plan"]);
const SENSITIVE_KEY = /(?:authorization|cookie|pass(?:word)?|token|secret|api[_-]?key|bearer|credential)/i;

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function truncateUtf8(value, maxBytes) {
  const text = typeof value === "string" ? value : "";
  if (maxBytes <= 0 || !text) return "";
  if (byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function cleanText(value, maxBytes = 4096) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  return truncateUtf8(cleaned, maxBytes);
}

function cleanKey(value) {
  const key = cleanText(value, 120);
  return /^[a-z][a-zA-Z0-9.-]{0,119}$/.test(key) ? key : "";
}

function cleanParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 8)) {
    const key = cleanText(rawKey, 40);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (typeof rawValue === "string") output[key] = cleanText(rawValue, 320);
    else if (Number.isFinite(rawValue)) output[key] = rawValue;
  }
  return output;
}

function sanitizeValue(value, key = "", state = null, depth = 0) {
  const budget = state || { remainingBytes: HISTORY_VALUE_BUDGET_BYTES, nodes: 0, truncated: false };
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (budget.nodes >= HISTORY_MAX_NODES || depth > HISTORY_MAX_DEPTH) {
    budget.truncated = true;
    return "[TRUNCATED]";
  }
  budget.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const maximum = Math.min(64 * 1024, budget.remainingBytes);
    const cleaned = cleanText(value, maximum);
    const used = byteLength(cleaned);
    budget.remainingBytes = Math.max(0, budget.remainingBytes - used);
    if (used < byteLength(value)) budget.truncated = true;
    return cleaned;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) budget.truncated = true;
    return value.slice(0, 100).map(item => sanitizeValue(item, key, budget, depth + 1));
  }
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value);
  if (entries.length > 200) budget.truncated = true;
  const output = {};
  for (const [rawKey, item] of entries.slice(0, 200)) {
    const childKey = cleanText(rawKey, 160);
    if (!childKey || childKey === "sourcePid" || childKey === "pidChain") continue;
    output[childKey] = sanitizeValue(item, childKey, budget, depth + 1);
  }
  return output;
}

function cleanQuestions(value, state) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((question, index) => ({
    id: cleanText(question?.id, 240) || `question_${index + 1}`,
    header: cleanText(question?.header, 240),
    question: cleanText(question?.question, 4000),
    questionKey: cleanKey(question?.questionKey),
    multiSelect: question?.multiSelect === true,
    allowText: question?.allowText !== false,
    options: Array.isArray(question?.options) ? question.options.slice(0, 20).map(option => ({
      id: cleanText(option?.id, 240),
      label: cleanText(option?.label, 1000),
      description: cleanText(option?.description, 2000),
    })).filter(option => option.id || option.label) : [],
  })).map(question => sanitizeValue(question, "questions", state));
}

function cleanAnswers(value, state) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [rawKey, answer] of Object.entries(value).slice(0, 10)) {
    const key = cleanText(rawKey, 240);
    if (!key) continue;
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    const values = Array.isArray(answer) ? answer.slice(0, 20) : [answer];
    const cleaned = values.map(item => sanitizeValue(item, "answer", state)).filter(item => (
      typeof item === "string" ? item.length > 0 : item !== null
    ));
    if (cleaned.length) output[key] = Array.isArray(answer) ? cleaned : cleaned[0];
  }
  return output;
}

function normalizeRecord(input, options = {}) {
  if (!input || typeof input !== "object" || !HISTORY_KINDS.has(input.kind)) return null;
  const state = { remainingBytes: HISTORY_VALUE_BUDGET_BYTES, nodes: 0, truncated: false };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const contentLimit = Math.min(64 * 1024, state.remainingBytes);
  const content = cleanText(input.content, contentLimit);
  if (byteLength(input.content) > byteLength(content)) state.truncated = true;
  state.remainingBytes = Math.max(0, state.remainingBytes - byteLength(content));
  const record = {
    id: /^[0-9a-f-]{16,80}$/i.test(input.id || "") ? input.id : crypto.randomUUID(),
    kind: input.kind,
    agentId: cleanText(input.agentId, 160) || "unknown",
    agentName: cleanText(input.agentName, 240) || cleanText(input.agentId, 160) || "Agent",
    sessionId: cleanText(input.sessionId, 1000),
    title: cleanText(input.title, 2000),
    titleKey: cleanKey(input.titleKey),
    titleParams: cleanParams(input.titleParams),
    toolName: cleanText(input.toolName, 640),
    description: cleanText(input.description, 8000),
    cwd: cleanText(input.cwd, 8000),
    toolInput: sanitizeValue(input.toolInput || {}, "toolInput", state),
    questions: cleanQuestions(input.questions, state),
    answers: cleanAnswers(input.answers, state),
    answerAvailable: input.answerAvailable === true,
    outcome: cleanText(input.outcome, 160) || "unknown",
    outcomeLabel: cleanText(input.outcomeLabel, 640),
    outcomeLabelKey: cleanKey(input.outcomeLabelKey),
    outcomeLabelParams: cleanParams(input.outcomeLabelParams),
    reason: cleanText(input.reason, 480),
    content,
    contentKey: cleanKey(input.contentKey),
    contentParams: cleanParams(input.contentParams),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    finalizedAt: Number.isFinite(input.finalizedAt) ? input.finalizedAt : now,
    truncated: state.truncated === true || input.truncated === true,
  };
  const serialized = JSON.stringify(record);
  if (byteLength(serialized) <= HISTORY_MAX_RECORD_BYTES) return record;
  record.toolInput = { notice: "[TRUNCATED]" };
  record.questions = record.questions.slice(0, 3);
  record.answers = cleanAnswers(record.answers, { remainingBytes: 12 * 1024, nodes: 0, truncated: true });
  record.content = truncateUtf8(record.content, 24 * 1024);
  record.description = truncateUtf8(record.description, 4000);
  record.truncated = true;
  return byteLength(JSON.stringify(record)) <= HISTORY_MAX_RECORD_BYTES ? record : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordTime(record) {
  return Number.isFinite(record?.finalizedAt) ? record.finalizedAt : (Number.isFinite(record?.createdAt) ? record.createdAt : 0);
}

function summaryText(record) {
  if (record.kind === "plan") return cleanText(record.content, 320);
  const input = record.toolInput || {};
  for (const key of ["command", "cmd", "patch", "query", "path", "file_path", "url"]) {
    if (typeof input[key] === "string" && input[key].trim()) return cleanText(input[key], 320);
  }
  if (record.questions[0]?.question) return cleanText(record.questions[0].question, 320);
  return cleanText(record.description, 320);
}

class HistoryStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.filePath = options.filePath || "";
    this.safeStorage = options.safeStorage || null;
    this.platform = options.platform || process.platform;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.now = options.now || Date.now;
    this.fs = options.fs || fs;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.entries = [];
    this.mode = "memory";
    this.lastError = "";
    this.saveTimer = null;
    this.loaded = false;
  }

  storageMode() {
    try {
      const available = this.safeStorage?.isEncryptionAvailable?.() === true;
      const backend = this.platform === "linux" ? this.safeStorage?.getSelectedStorageBackend?.() : "secure";
      return available && backend !== "basic_text" ? "encrypted" : "plaintext";
    } catch {
      return "plaintext";
    }
  }

  load() {
    this.mode = this.storageMode();
    this.loaded = true;
    if (!this.filePath || !this.fs.existsSync(this.filePath)) return this.snapshot();
    try {
      const envelope = JSON.parse(this.fs.readFileSync(this.filePath, "utf8"));
      if (envelope?.version !== HISTORY_VERSION || !["encrypted", "plaintext"].includes(envelope.mode)) {
        throw new Error("history-format-invalid");
      }
      let payload;
      if (envelope.mode === "encrypted") {
        if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error("history-decryption-unavailable");
        payload = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.payload || "", "base64")));
      } else {
        payload = { entries: envelope.entries };
      }
      this.entries = Array.isArray(payload?.entries)
        ? payload.entries.map(entry => normalizeRecord(entry, { now: this.now() })).filter(Boolean)
        : [];
      this.prune(false);
      this.lastError = "";
    } catch (error) {
      this.entries = [];
      this.mode = "memory";
      this.lastError = cleanText(error?.message, 160) || "history-load-failed";
      this.logger.warn("History file could not be loaded", { code: this.lastError });
    }
    return this.snapshot();
  }

  append(input) {
    const record = normalizeRecord(input, { now: this.now() });
    if (!record) return null;
    const existing = this.entries.findIndex(entry => entry.id === record.id);
    if (existing >= 0) this.entries.splice(existing, 1);
    this.entries.unshift(record);
    this.prune(false);
    this.scheduleSave();
    this.emit("changed", this.snapshot(), "appended");
    return clone(record);
  }

  prune(emit = true) {
    const cutoff = this.now() - HISTORY_RETENTION_MS;
    this.entries = this.entries
      .filter(entry => recordTime(entry) >= cutoff)
      .sort((left, right) => recordTime(right) - recordTime(left))
      .slice(0, HISTORY_MAX_ENTRIES);
    const emptyBytes = byteLength(JSON.stringify({ version: HISTORY_VERSION, mode: "plaintext", entries: [] }));
    const sizes = this.entries.map(entry => byteLength(JSON.stringify(entry)));
    let totalBytes = emptyBytes + sizes.reduce((sum, size, index) => sum + size + (index ? 1 : 0), 0);
    while (this.entries.length > 0 && totalBytes > HISTORY_MAX_FILE_BYTES) {
      const removedSize = sizes.pop();
      this.entries.pop();
      totalBytes -= removedSize + (this.entries.length ? 1 : 0);
    }
    if (emit) this.emit("changed", this.snapshot(), "pruned");
  }

  list() {
    return this.entries.map(record => ({
      id: record.id,
      kind: record.kind,
      agentId: record.agentId,
      agentName: record.agentName,
      title: cleanText(record.title, 640),
      titleKey: record.titleKey,
      titleParams: clone(record.titleParams),
      toolName: cleanText(record.toolName, 320),
      cwd: cleanText(record.cwd, 2000),
      outcome: record.outcome,
      outcomeLabel: cleanText(record.outcomeLabel, 640),
      outcomeLabelKey: record.outcomeLabelKey,
      outcomeLabelParams: clone(record.outcomeLabelParams),
      reason: cleanText(record.reason, 240),
      createdAt: record.createdAt,
      finalizedAt: record.finalizedAt,
      truncated: record.truncated,
      summary: summaryText(record),
    }));
  }

  get(id) {
    if (typeof id !== "string") return null;
    const record = this.entries.find(entry => entry.id === id);
    return record ? clone(record) : null;
  }

  remove(id) {
    if (typeof id !== "string") return false;
    const index = this.entries.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.scheduleSave();
    this.emit("changed", this.snapshot(), "removed");
    return true;
  }

  clear(reason = "cleared") {
    if (!this.entries.length) return false;
    this.entries = [];
    this.scheduleSave();
    this.emit("changed", this.snapshot(), reason);
    return true;
  }

  scheduleSave() {
    if (!this.loaded || this.mode === "memory" || !this.filePath) return;
    if (this.saveTimer) this.clearTimer(this.saveTimer);
    this.saveTimer = this.setTimer(() => {
      this.saveTimer = null;
      this.flush();
    }, 80);
    this.saveTimer?.unref?.();
  }

  envelope() {
    if (this.mode === "encrypted") {
      const payload = JSON.stringify({ entries: this.entries });
      return { version: HISTORY_VERSION, mode: "encrypted", payload: this.safeStorage.encryptString(payload).toString("base64") };
    }
    return { version: HISTORY_VERSION, mode: "plaintext", entries: this.entries };
  }

  flush() {
    if (this.saveTimer) this.clearTimer(this.saveTimer);
    this.saveTimer = null;
    if (!this.loaded || this.mode === "memory" || !this.filePath) return false;
    const originalEntries = this.entries;
    const originalCount = this.entries.length;
    try {
      let serialized = `${JSON.stringify(this.envelope())}\n`;
      if (byteLength(serialized) > HISTORY_MAX_FILE_BYTES && this.entries.length) {
        const original = this.entries;
        let low = 0;
        let high = original.length;
        let best = "";
        let bestCount = 0;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          this.entries = original.slice(0, middle);
          const candidate = `${JSON.stringify(this.envelope())}\n`;
          if (byteLength(candidate) <= HISTORY_MAX_FILE_BYTES) {
            best = candidate;
            bestCount = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        this.entries = original.slice(0, bestCount);
        serialized = best || `${JSON.stringify(this.envelope())}\n`;
      }
      this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      this.fs.writeFileSync(temp, serialized, "utf8");
      this.fs.renameSync(temp, this.filePath);
      this.lastError = "";
      if (this.entries.length !== originalCount) this.emit("changed", this.snapshot(), "capacity-pruned");
      return true;
    } catch (error) {
      this.entries = originalEntries;
      this.lastError = cleanText(error?.message, 160) || "history-save-failed";
      this.logger.warn("History file could not be saved", { code: this.lastError });
      return false;
    }
  }

  snapshot() {
    return {
      count: this.entries.length,
      mode: this.mode,
      filePath: this.filePath,
      lastError: this.lastError,
      retentionDays: 30,
      maxEntries: HISTORY_MAX_ENTRIES,
      maxFileBytes: HISTORY_MAX_FILE_BYTES,
    };
  }

  stop() {
    this.flush();
    this.removeAllListeners();
  }
}

module.exports = {
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_FILE_BYTES,
  HISTORY_MAX_RECORD_BYTES,
  HISTORY_RETENTION_MS,
  HISTORY_VERSION,
  HistoryStore,
  cleanAnswers,
  normalizeRecord,
  sanitizeValue,
  summaryText,
  truncateUtf8,
};
