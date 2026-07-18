"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { INPUT_REMINDER_TIMEOUT_MS } = require("./constants");

function clean(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function publicItem(item) {
  if (!item) return null;
  const { requestKey: _requestKey, timer: _timer, ...safe } = item;
  return safe;
}

function cleanQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((question, index) => ({
    header: clean(question?.header, 80),
    id: clean(question?.id, 120) || `question_${index + 1}`,
    question: clean(question?.question, 600) || "Codex 正在等待你的输入。",
    options: Array.isArray(question?.options)
      ? question.options.slice(0, 4).map(option => ({
        label: clean(option?.label, 120),
        description: clean(option?.description, 300),
      })).filter(option => option.label)
      : [],
  }));
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

    const item = {
      id: crypto.randomUUID(),
      type: "input-request",
      requestKey,
      sessionId: clean(input.sessionId, 240) || "codex:unknown",
      title: clean(input.title, 240) || "Codex 等待你的选择",
      content: clean(input.content, 6000) || "请回到 Codex 原生界面完成选择。",
      questions: cleanQuestions(input.questions),
      cwd: clean(input.cwd, 2000),
      questionCount: Number.isInteger(input.questionCount)
        ? Math.max(0, Math.min(input.questionCount, 3))
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

  clearSession(sessionId, reason = "session-cleared") {
    const normalized = clean(sessionId, 240);
    if (!normalized) return false;
    const removed = this.queue.filter(item => item.sessionId === normalized);
    if (removed.length === 0) return false;
    for (const item of removed) {
      this.byRequestKey.delete(item.requestKey);
      if (item.timer) this.clearTimer(item.timer);
    }
    this.queue = this.queue.filter(item => item.sessionId !== normalized);
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
