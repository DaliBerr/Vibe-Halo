"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { APPROVAL_TIMEOUT_MS } = require("./constants");

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value || {})).digest("hex");
}

function safeText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function publicEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    type: entry.kind === "elicitation" ? "elicitation" : "approval",
    agentId: entry.agentId,
    agentName: entry.agentName,
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    toolName: entry.toolName,
    toolInput: entry.toolInput,
    description: entry.description,
    cwd: entry.cwd,
    options: entry.options.map(option => ({ ...option })),
    questions: entry.questions.map(question => ({
      ...question,
      options: question.options.map(option => ({ ...option })),
    })),
    createdAt: entry.createdAt,
  };
}

class ApprovalStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeoutMs || APPROVAL_TIMEOUT_MS;
    this.createId = options.createId || (() => crypto.randomUUID());
    this.now = options.now || Date.now;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.entries = [];
    this.byKey = new Map();
  }

  get size() {
    return this.entries.length;
  }

  get current() {
    return this.entries[0] || null;
  }

  snapshot() {
    return { current: publicEntry(this.current), pendingCount: this.size };
  }

  buildKey(request) {
    const agentId = safeText(request.agentId, 80) || "unknown";
    const session = safeText(request.sessionId, 240) || `${agentId}:unknown`;
    const identity = safeText(request.requestId, 240) || safeText(request.toolUseId, 240)
      || safeText(request.fingerprint, 128) || fingerprint(request.toolInput);
    return `${agentId}\u0000${session}\u0000${identity}`;
  }

  enqueue(request, waiter) {
    if (!waiter || typeof waiter.complete !== "function") throw new TypeError("waiter.complete is required");
    const key = this.buildKey(request);
    const existing = this.byKey.get(key);
    if (existing && existing.state === "pending") {
      existing.waiters.add(waiter);
      this.emit("waiter-added", existing.id);
      return { entry: existing, duplicate: true };
    }

    const entry = {
      id: this.createId(),
      key,
      state: "pending",
      agentId: safeText(request.agentId, 80) || "unknown",
      agentName: safeText(request.agentName, 120) || safeText(request.agentId, 80) || "Agent",
      kind: request.kind === "elicitation" ? "elicitation" : "approval",
      sessionId: safeText(request.sessionId, 240) || `${safeText(request.agentId, 80) || "unknown"}:unknown`,
      requestId: safeText(request.requestId, 240),
      toolUseId: safeText(request.toolUseId, 240),
      toolName: safeText(request.toolName, 160) || "Unknown",
      toolInput: request.toolInput && typeof request.toolInput === "object" ? request.toolInput : {},
      description: safeText(request.description, 1000),
      cwd: safeText(request.cwd, 2000),
      sourcePid: Number.isInteger(request.sourcePid) ? request.sourcePid : null,
      pidChain: Array.isArray(request.pidChain) ? request.pidChain.filter(Number.isInteger).slice(0, 32) : [],
      options: (Array.isArray(request.options) && request.options.length ? request.options : [
        { id: "allow", label: "允许一次", tone: "primary" },
        { id: "deny", label: "拒绝", tone: "danger" },
        { id: "native", label: "在客户端处理", tone: "secondary" },
      ]).slice(0, 12).map(option => ({
        id: safeText(option?.id, 80),
        label: safeText(option?.label, 160),
        tone: ["primary", "danger", "secondary"].includes(option?.tone) ? option.tone : "secondary",
        overflow: option?.overflow === true,
      })).filter(option => option.id && option.label),
      questions: Array.isArray(request.questions) ? request.questions.slice(0, 10).map(question => ({
        id: safeText(question?.id, 120),
        header: safeText(question?.header, 120),
        question: safeText(question?.question, 1000),
        multiSelect: question?.multiSelect === true,
        allowText: question?.allowText !== false,
        options: Array.isArray(question?.options) ? question.options.slice(0, 20).map(option => ({
          id: safeText(option?.id, 120),
          label: safeText(option?.label, 240),
          description: safeText(option?.description, 600),
        })).filter(option => option.id && option.label) : [],
      })).filter(question => question.id && question.question) : [],
      createdAt: this.now(),
      waiters: new Set([waiter]),
      timer: null,
    };
    entry.timer = this.setTimer(() => this.expire(entry.id), this.timeoutMs);
    if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
    this.entries.push(entry);
    this.byKey.set(key, entry);
    this.emit("changed", this.snapshot(), "enqueued");
    return { entry, duplicate: false };
  }

  disconnect(id, waiter) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.state !== "pending") return false;
    entry.waiters.delete(waiter);
    if (entry.waiters.size > 0) return true;
    this.finalize(entry, "disconnected", null, "all-waiters-disconnected", false);
    return true;
  }

  resolve(id, optionId, payload = {}) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.state !== "pending") return false;
    const normalized = optionId === "no-decision" ? "native" : safeText(optionId, 80);
    if (normalized !== "native" && !entry.options.some(option => option.id === normalized)) return false;
    const decision = {
      optionId: normalized,
      message: safeText(typeof payload === "string" ? payload : payload?.message, 500),
    };
    if (payload && typeof payload === "object" && payload.answers && typeof payload.answers === "object") {
      decision.answers = payload.answers;
    }
    this.finalize(entry, "resolved", decision, normalized, true);
    return true;
  }

  expire(id) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.state !== "pending") return false;
    this.finalize(entry, "expired", { optionId: "native" }, "timeout", true);
    return true;
  }

  finalize(entry, finalState, output, reason, completeWaiters) {
    if (entry.state !== "pending") return;
    entry.state = "resolving";
    if (entry.timer) this.clearTimer(entry.timer);
    const index = this.entries.indexOf(entry);
    if (index >= 0) this.entries.splice(index, 1);
    this.byKey.delete(entry.key);
    entry.state = finalState;
    if (completeWaiters) {
      for (const waiter of entry.waiters) {
        try { waiter.complete(output); } catch {}
      }
    }
    entry.waiters.clear();
    this.emit("resolved", { id: entry.id, state: finalState, reason });
    this.emit("changed", this.snapshot(), reason);
  }

  shutdown() {
    for (const entry of [...this.entries]) {
      this.finalize(entry, "resolved", { optionId: "native" }, "shutdown", true);
    }
  }
}

module.exports = { ApprovalStore, fingerprint, stableStringify, publicEntry };
