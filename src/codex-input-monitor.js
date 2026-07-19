"use strict";

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const {
  CODEX_INPUT_POLL_INTERVAL_MS,
  CODEX_INPUT_RECOVERY_MAX_AGE_MS,
  CODEX_INPUT_RESCAN_INTERVAL_MS,
} = require("./constants");

const MAX_INITIAL_READ_BYTES = 2 * 1024 * 1024;

function defaultCodexHome() {
  const configured = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  return configured || path.join(os.homedir(), ".codex");
}

function safeText(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length > 256 * 1024) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeQuestions(argumentsValue) {
  const data = parseArguments(argumentsValue);
  if (!Array.isArray(data.questions)) return [];
  return data.questions.slice(0, 3).map((question, index) => {
    const value = question && typeof question === "object" ? question : {};
    const options = Array.isArray(value.options)
      ? value.options.slice(0, 4).map(option => ({
        label: safeText(option?.label, 120),
        description: safeText(option?.description, 300),
      })).filter(option => option.label)
      : [];
    return {
      header: safeText(value.header, 80),
      id: safeText(value.id, 120) || `question_${index + 1}`,
      question: safeText(value.question, 600),
      questionKey: safeText(value.question, 600) ? "" : "fallback.codexWaitingInput",
      options,
    };
  });
}

function formatQuestions(questions) {
  if (!questions.length) return "";
  const lines = [];
  questions.forEach((question, index) => {
    if (question.question) lines.push(`${index + 1}. ${question.question}`);
    for (const option of question.options) {
      lines.push(`   • ${option.label}${option.description ? ` — ${option.description}` : ""}`);
    }
    if (index < questions.length - 1) lines.push("");
  });
  return lines.join("\n").slice(0, 6000);
}

function sessionIdFromFile(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match ? match[1] : "codex:unknown";
}

function requestKeyFor(filePath, callId) {
  return crypto.createHash("sha256").update(filePath).update("\0").update(callId).digest("hex");
}

class CodexInputMonitor {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.sessionsDir = options.sessionsDir || path.join(defaultCodexHome(), "sessions");
    this.pollIntervalMs = options.pollIntervalMs || CODEX_INPUT_POLL_INTERVAL_MS;
    this.rescanIntervalMs = options.rescanIntervalMs || CODEX_INPUT_RESCAN_INTERVAL_MS;
    this.recoveryMaxAgeMs = options.recoveryMaxAgeMs || CODEX_INPUT_RECOVERY_MAX_AGE_MS;
    this.now = options.now || Date.now;
    this.onRequested = options.onRequested || (() => true);
    this.onResolved = options.onResolved || (() => {});
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.files = new Map();
    this.pending = new Map();
    this.running = false;
    this.interval = null;
    this.watcher = null;
    this.debounce = null;
    this.lastRescanAt = 0;
    this.lastError = null;
    this.lastEventAt = null;
  }

  start() {
    if (this.running) return this.status();
    this.running = true;
    this.scanNow(true);
    this._startWatcher();
    this.interval = setInterval(() => this.scanNow(), this.pollIntervalMs);
    if (this.interval && typeof this.interval.unref === "function") this.interval.unref();
    this.logger.info("Codex input reminder monitor started", { sessionsDir: this.sessionsDir });
    return this.status();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    try { this.watcher?.close(); } catch {}
    this.interval = null;
    this.debounce = null;
    this.watcher = null;
    this.files.clear();
    this.pending.clear();
    this.logger.info("Codex input reminder monitor stopped");
  }

  status() {
    return {
      running: this.running,
      sessionsDir: this.sessionsDir,
      sessionsFound: this.fs.existsSync(this.sessionsDir),
      trackedFiles: this.files.size,
      pendingCount: this.pending.size,
      visiblePendingCount: [...this.pending.values()].filter(item => item.notified).length,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }

  scanNow(forceRescan = false) {
    try {
      const now = this.now();
      if (forceRescan || now - this.lastRescanAt >= this.rescanIntervalMs) {
        this._discover(now);
        this.lastRescanAt = now;
      }
      for (const [filePath, tracked] of this.files) this._readFile(filePath, tracked, now);
      this._expire(now);
      this._announcePending();
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      this.logger.warn("Codex input reminder scan failed", { message: error.message });
    }
    return this.status();
  }

  replayPending() {
    this._announcePending();
  }

  _startWatcher() {
    if (!this.fs.existsSync(this.sessionsDir)) return;
    try {
      this.watcher = this.fs.watch(this.sessionsDir, { recursive: true }, (_event, fileName) => {
        if (fileName && !String(fileName).endsWith(".jsonl")) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          if (this.running) this.scanNow(true);
        }, 80);
        if (this.debounce && typeof this.debounce.unref === "function") this.debounce.unref();
      });
      this.watcher.on?.("error", error => {
        this.lastError = error.message;
        this.logger.warn("Codex session watcher failed; polling remains active", { message: error.message });
      });
    } catch (error) {
      this.logger.warn("Codex session watcher unavailable; polling remains active", { message: error.message });
    }
  }

  _discover(now) {
    if (!this.fs.existsSync(this.sessionsDir)) return;
    const cutoff = now - this.recoveryMaxAgeMs;
    const seen = new Set();
    const walk = (dir, depth) => {
      if (depth > 5) return;
      let entries;
      try { entries = this.fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        let stat;
        try { stat = this.fs.statSync(fullPath); } catch { continue; }
        if (stat.mtimeMs < cutoff && !this.files.has(fullPath)) continue;
        seen.add(fullPath);
        if (!this.files.has(fullPath)) {
          this.files.set(fullPath, {
            offset: Math.max(0, stat.size - MAX_INITIAL_READ_BYTES),
            partial: "",
            dropFirstPartial: stat.size > MAX_INITIAL_READ_BYTES,
            sessionId: sessionIdFromFile(fullPath),
            cwd: "",
            mtimeMs: stat.mtimeMs,
          });
        }
      }
    };
    walk(this.sessionsDir, 0);

    for (const [filePath, tracked] of this.files) {
      const hasPending = [...this.pending.values()].some(item => item.filePath === filePath);
      if (!seen.has(filePath) && !hasPending && tracked.mtimeMs < cutoff) this.files.delete(filePath);
    }
  }

  _readFile(filePath, tracked, now) {
    let stat;
    try { stat = this.fs.statSync(filePath); } catch { return; }
    tracked.mtimeMs = stat.mtimeMs;
    if (stat.size < tracked.offset) {
      tracked.offset = 0;
      tracked.partial = "";
      tracked.dropFirstPartial = false;
    }
    if (stat.size === tracked.offset) return;
    const length = stat.size - tracked.offset;
    const buffer = Buffer.allocUnsafe(length);
    const startOffset = tracked.offset;
    let fd;
    let bytesRead = 0;
    try {
      fd = this.fs.openSync(filePath, "r");
      bytesRead = this.fs.readSync(fd, buffer, 0, length, startOffset);
    } finally {
      if (fd !== undefined) try { this.fs.closeSync(fd); } catch {}
    }
    tracked.offset = startOffset + bytesRead;
    let text = tracked.partial + buffer.subarray(0, bytesRead).toString("utf8");
    let lines = text.split(/\r?\n/);
    tracked.partial = lines.pop() || "";
    if (tracked.dropFirstPartial) {
      lines.shift();
      tracked.dropFirstPartial = false;
    }
    for (const line of lines) this._consumeLine(line, filePath, tracked, now);
  }

  _consumeLine(line, filePath, tracked, now) {
    if (!line || line.length > 1024 * 1024) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record?.type === "session_meta" && record.payload && typeof record.payload === "object") {
      tracked.sessionId = safeText(record.payload.session_id || record.payload.id, 240) || tracked.sessionId;
      tracked.cwd = safeText(record.payload.cwd, 2000);
      return;
    }
    if (record?.type !== "response_item" || !record.payload || typeof record.payload !== "object") return;
    const payload = record.payload;
    const callId = safeText(payload.call_id, 240);
    if (!callId) return;
    const requestKey = requestKeyFor(filePath, callId);

    if (payload.type === "function_call" && payload.name === "request_user_input") {
      const createdAt = Number.isFinite(Date.parse(record.timestamp)) ? Date.parse(record.timestamp) : now;
      if (createdAt < now - this.recoveryMaxAgeMs || this.pending.has(requestKey)) return;
      const questions = normalizeQuestions(payload.arguments);
      const content = formatQuestions(questions);
      this.pending.set(requestKey, {
        requestKey,
        callId,
        filePath,
        sessionId: tracked.sessionId,
        cwd: tracked.cwd,
        title: questions[0]?.header || "",
        titleKey: questions[0]?.header ? "" : "fallback.codexWaitingChoice",
        content,
        contentKey: content ? "" : "fallback.returnToCodex",
        questions,
        questionCount: questions.length,
        createdAt,
        notified: false,
      });
      return;
    }

    if (payload.type === "function_call_output") {
      const pending = this.pending.get(requestKey);
      if (!pending) return;
      this.pending.delete(requestKey);
      if (pending.notified) {
        this.lastEventAt = new Date(now).toISOString();
        this.onResolved(pending);
        this.logger.info("Codex input request resolved", { sessionId: pending.sessionId });
      }
    }
  }

  _announcePending() {
    for (const pending of this.pending.values()) {
      if (pending.notified) continue;
      let accepted = false;
      try { accepted = this.onRequested({ ...pending, notified: undefined }) !== false; }
      catch (error) { this.logger.warn("Codex input reminder handler failed", { message: error.message }); }
      if (!accepted) continue;
      pending.notified = true;
      this.lastEventAt = new Date(this.now()).toISOString();
      this.logger.info("Codex input request detected", {
        sessionId: pending.sessionId,
        questionCount: pending.questionCount,
      });
    }
  }

  _expire(now) {
    for (const [requestKey, pending] of this.pending) {
      if (pending.createdAt >= now - this.recoveryMaxAgeMs) continue;
      this.pending.delete(requestKey);
      if (pending.notified) this.onResolved(pending);
    }
  }
}

module.exports = {
  CodexInputMonitor,
  formatQuestions,
  normalizeQuestions,
  requestKeyFor,
  sessionIdFromFile,
};
