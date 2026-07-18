"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { COMPLETION_TIMEOUT_MS } = require("./constants");

function clean(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
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
    const item = {
      id: crypto.randomUUID(),
      type: "completion",
      agentId: clean(input.agentId, 80) || "codex",
      agentName: clean(input.agentName, 120) || "Codex",
      sessionId: clean(input.sessionId, 240),
      title: clean(input.title, 240) || "Codex 已完成",
      output: clean(input.output, 6000),
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
