"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { APPROVAL_TIMEOUT_MS } = require("./constants");
const { buildDecisionOutput, noDecisionOutput } = require("./codex-output");

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
    type: "approval",
    sessionId: entry.sessionId,
    toolName: entry.toolName,
    toolInput: entry.toolInput,
    description: entry.description,
    cwd: entry.cwd,
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
    const session = safeText(request.sessionId, 240) || "codex:unknown";
    const identity = safeText(request.toolUseId, 240) || safeText(request.fingerprint, 128) || fingerprint(request.toolInput);
    return `${session}\u0000${identity}`;
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
      sessionId: safeText(request.sessionId, 240) || "codex:unknown",
      toolUseId: safeText(request.toolUseId, 240),
      toolName: safeText(request.toolName, 160) || "Unknown",
      toolInput: request.toolInput && typeof request.toolInput === "object" ? request.toolInput : {},
      description: safeText(request.description, 1000),
      cwd: safeText(request.cwd, 2000),
      sourcePid: Number.isInteger(request.sourcePid) ? request.sourcePid : null,
      pidChain: Array.isArray(request.pidChain) ? request.pidChain.filter(Number.isInteger).slice(0, 32) : [],
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
    this.finalize(entry, "disconnected", noDecisionOutput(), "all-waiters-disconnected", false);
    return true;
  }

  resolve(id, behavior, message) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.state !== "pending") return false;
    if (behavior !== "allow" && behavior !== "deny" && behavior !== "no-decision") return false;
    const output = behavior === "no-decision"
      ? noDecisionOutput()
      : buildDecisionOutput(behavior, behavior === "deny" ? (message || "Denied in Vibe Halo") : undefined);
    this.finalize(entry, "resolved", output, behavior, true);
    return true;
  }

  expire(id) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.state !== "pending") return false;
    this.finalize(entry, "expired", noDecisionOutput(), "timeout", true);
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
      this.finalize(entry, "resolved", noDecisionOutput(), "shutdown", true);
    }
  }
}

module.exports = { ApprovalStore, fingerprint, stableStringify, publicEntry };
