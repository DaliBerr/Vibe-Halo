"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { COMPLETION_TIMEOUT_MS } = require("./constants");

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

class CompletionStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeoutMs || COMPLETION_TIMEOUT_MS;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.current = null;
  }

  show(input) {
    this.clear("replaced");
    const agentName = clean(input.agentName, 120) || "Codex";
    const title = clean(input.title, 240);
    const output = clean(input.output, 6000);
    const item = {
      id: crypto.randomUUID(),
      type: "completion",
      completionKind: input.completionKind === "plan" ? "plan" : "task",
      agentId: clean(input.agentId, 80) || "codex",
      agentName,
      sessionId: clean(input.sessionId, 240),
      title,
      titleKey: cleanKey(input.titleKey) || (title ? "" : "fallback.completionTitle"),
      titleParams: cleanParams(input.titleParams || { agentName }),
      output,
      outputKey: cleanKey(input.outputKey) || (output ? "" : "fallback.taskCompleted"),
      outputParams: cleanParams(input.outputParams),
      cwd: clean(input.cwd, 2000),
      sourcePid: Number.isInteger(input.sourcePid) ? input.sourcePid : null,
      pidChain: Array.isArray(input.pidChain) ? input.pidChain.filter(Number.isInteger).slice(0, 32) : [],
      expanded: false,
      createdAt: Date.now(),
      timer: null,
    };
    item.timer = this.setTimer(() => this.clear("auto-close"), this.timeoutMs);
    if (item.timer && typeof item.timer.unref === "function") item.timer.unref();
    this.current = item;
    this.emit("changed", this.snapshot(), "shown");
    return item;
  }

  expand(id) {
    if (!this.current || this.current.id !== id) return false;
    if (this.current.timer) this.clearTimer(this.current.timer);
    this.current.timer = null;
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

  clear(reason = "cleared", sessionId = null, agentId = null) {
    if (!this.current) return false;
    if (sessionId && this.current.sessionId !== sessionId) return false;
    if (agentId && this.current.agentId !== agentId) return false;
    if (this.current.timer) this.clearTimer(this.current.timer);
    this.current = null;
    this.emit("changed", this.snapshot(), reason);
    return true;
  }

  snapshot() {
    if (!this.current) return null;
    const { timer, ...safe } = this.current;
    return safe;
  }
}

module.exports = { CompletionStore };
