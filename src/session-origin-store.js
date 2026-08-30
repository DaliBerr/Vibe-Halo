"use strict";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

function cleanText(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function originKey(agentId, sessionId) {
  const agent = cleanText(agentId, 80).toLowerCase();
  const session = cleanText(sessionId, 240);
  if (!agent || !session || session === `${agent}:unknown`) return "";
  return `${agent}\u0000${session}`;
}

class SessionOriginStore {
  constructor(options = {}) {
    this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : DEFAULT_MAX_ENTRIES;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_TTL_MS;
    this.now = options.now || Date.now;
    this.entries = new Map();
  }

  remember(input = {}) {
    const key = originKey(input.agentId, input.sessionId);
    if (!key) return false;
    const sourcePid = positiveInteger(input.sourcePid);
    const candidates = [sourcePid, ...(Array.isArray(input.pidChain) ? input.pidChain : [])]
      .map(positiveInteger)
      .filter(Boolean);
    const pidChain = [...new Set(candidates)].slice(0, 32);
    if (pidChain.length === 0) return false;
    const updatedAt = this.now();
    const entry = {
      sourcePid: sourcePid || pidChain[0],
      pidChain,
      cwd: cleanText(input.cwd, 2000),
      updatedAt,
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.prune(updatedAt);
    return true;
  }

  get(agentId, sessionId) {
    const key = originKey(agentId, sessionId);
    if (!key) return null;
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry, pidChain: [...entry.pidChain] };
  }

  prune(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.updatedAt < now - this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  SessionOriginStore,
  originKey,
  positiveInteger,
};
