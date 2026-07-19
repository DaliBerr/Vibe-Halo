"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { INPUT_REMINDER_TIMEOUT_MS } = require("./constants");

function clean(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function cleanKey(value) {
  const key = clean(value, 120);
  return /^[a-z][a-zA-Z0-9.-]{0,119}$/.test(key) ? key : "";
}

function cleanParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 8)) {
    const key = clean(rawKey, 40);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (typeof rawValue === "string") output[key] = clean(rawValue, 160);
    else if (Number.isFinite(rawValue)) output[key] = rawValue;
  }
  return output;
}

function publicItem(item) {
  if (!item) return null;
  const { requestKey: _requestKey, timer: _timer, ...safe } = item;
  return safe;
}

function cleanQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((question, index) => {
    const questionText = clean(question?.question, 600);
    return {
      header: clean(question?.header, 80),
      id: clean(question?.id, 120) || `question_${index + 1}`,
      question: questionText,
      questionKey: cleanKey(question?.questionKey) || (questionText ? "" : "fallback.codexWaitingInput"),
      options: Array.isArray(question?.options)
        ? question.options.slice(0, 20).map(option => ({
          label: clean(option?.label, 120),
          description: clean(option?.description, 300),
        })).filter(option => option.label)
        : [],
    };
  });
}

class InputRequestStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeoutMs || INPUT_REMINDER_TIMEOUT_MS;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.queue = [];
    this.byRequestKey = new Map();
  }

  get current() {
    return this.queue[0] || null;
  }

  get size() {
    return this.queue.length;
  }

  enqueue(input) {
    const requestKey = clean(input?.requestKey, 1000);
    if (!requestKey) return { entry: null, duplicate: false };
    const existing = this.byRequestKey.get(requestKey);
    if (existing) return { entry: existing, duplicate: true };

    const agentName = clean(input.agentName, 120) || "Codex";
    const title = clean(input.title, 240);
    const content = clean(input.content, 6000);
    const item = {
      id: crypto.randomUUID(),
      type: "input-request",
      agentId: clean(input.agentId, 80) || "codex",
      agentName,
      requestKey,
      sessionId: clean(input.sessionId, 240) || "codex:unknown",
      title,
      titleKey: cleanKey(input.titleKey) || (title ? "" : "fallback.codexWaitingChoice"),
      titleParams: cleanParams(input.titleParams),
      content,
      contentKey: cleanKey(input.contentKey) || (content ? "" : "fallback.returnToCodex"),
      contentParams: cleanParams(input.contentParams),
      questions: cleanQuestions(input.questions),
      cwd: clean(input.cwd, 2000),
      questionCount: Number.isInteger(input.questionCount)
        ? Math.max(0, Math.min(input.questionCount, 10))
        : 0,
      sourcePid: Number.isInteger(input.sourcePid) ? input.sourcePid : null,
      pidChain: Array.isArray(input.pidChain) ? input.pidChain.filter(Number.isInteger).slice(0, 32) : [],
      expanded: false,
      createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
      timer: null,
    };
    item.timer = this.setTimer(() => this.removeById(item.id, "expired"), this.timeoutMs);
    if (item.timer && typeof item.timer.unref === "function") item.timer.unref();
    this.queue.push(item);
    this.byRequestKey.set(requestKey, item);
    this.emit("changed", this.snapshot(), "queued");
    return { entry: item, duplicate: false };
  }

  resolve(requestKey) {
    const item = this.byRequestKey.get(requestKey);
    return item ? this.removeById(item.id, "answered") : false;
  }

  dismiss(id) {
    return this.removeById(id, "dismissed");
  }

  removeById(id, reason) {
    const index = this.queue.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [item] = this.queue.splice(index, 1);
    this.byRequestKey.delete(item.requestKey);
    if (item.timer) this.clearTimer(item.timer);
    this.emit("changed", this.snapshot(), reason);
    return true;
  }

  expand(id) {
    if (!this.current || this.current.id !== id) return false;
    this.current.expanded = true;
    this.emit("changed", this.snapshot(), "expanded");
    return true;
  }

  collapse(id) {
    if (!this.current || this.current.id !== id) return false;
    this.current.expanded = false;
    this.emit("changed", this.snapshot(), "collapsed");
    return true;
  }

  clear(reason = "cleared") {
    if (this.queue.length === 0) return false;
    for (const item of this.queue) {
      if (item.timer) this.clearTimer(item.timer);
    }
    this.queue = [];
    this.byRequestKey.clear();
    this.emit("changed", this.snapshot(), reason);
    return true;
  }

  clearSession(sessionId, reason = "session-cleared", agentId = null) {
    const normalized = clean(sessionId, 240);
    if (!normalized) return false;
    const normalizedAgent = clean(agentId, 80);
    const removed = this.queue.filter(item => item.sessionId === normalized && (!normalizedAgent || item.agentId === normalizedAgent));
    if (removed.length === 0) return false;
    for (const item of removed) {
      this.byRequestKey.delete(item.requestKey);
      if (item.timer) this.clearTimer(item.timer);
    }
    this.queue = this.queue.filter(item => item.sessionId !== normalized || (normalizedAgent && item.agentId !== normalizedAgent));
    this.emit("changed", this.snapshot(), reason);
    return true;
  }

  snapshot() {
    return {
      current: publicItem(this.current),
      pendingCount: this.queue.length,
    };
  }
}

module.exports = { InputRequestStore };
