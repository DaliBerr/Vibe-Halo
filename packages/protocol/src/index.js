"use strict";

const validators = require("../generated/validators");
const LIMITS = Object.freeze({ controlBytes: 16 * 1024, detailBytes: 64 * 1024, envelopeBytes: 256 * 1024, depth: 12, nodes: 4096 });
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function safeTree(value, depth = 0, state = { nodes: 0, seen: new Set() }) {
  if (++state.nodes > LIMITS.nodes || depth > LIMITS.depth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  // Transport objects contain compact JWE strings larger than their plaintext.
  // validate()/parse() still apply the smaller limit to each plaintext schema.
  if (typeof value === "string") return value.length <= LIMITS.envelopeBytes && value.isWellFormed();
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (state.seen.has(value) || Reflect.ownKeys(value).some(key => typeof key !== "string" || FORBIDDEN.has(key))) return false;
  state.seen.add(value);
  const keys = Object.keys(value);
  if (keys.length > 500) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !safeTree(descriptor.value, depth + 1, state)) return false;
  }
  state.seen.delete(value);
  return true;
}

function validate(kind, value) {
  if (!Object.hasOwn(validators, kind) || !safeTree(value)) return { ok: false, error: "invalid_structure" };
  const limit = kind === "eventDetail" ? LIMITS.detailBytes : LIMITS.controlBytes;
  if (encoder.encode(JSON.stringify(value)).length > limit) return { ok: false, error: "too_large" };
  if (value?.protocolVersion !== 1) return { ok: false, error: "upgrade_required" };
  if (!validators[kind](value)) return { ok: false, error: "invalid_structure" };
  const times = kind === "eventDetail" ? [value.pcTime, value.summary.createdAt, value.summary.expiresAt]
    : kind === "eventSummary" ? [value.createdAt, value.expiresAt] : [value.issuedAt, value.expiresAt];
  if (times.some(time => !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)) return { ok: false, error: "invalid_structure" };
  if (Date.parse(times.at(-1)) <= Date.parse(times.at(-2))) return { ok: false, error: "invalid_structure" };
  return { ok: true };
}

function parse(kind, text) {
  const limit = kind === "eventDetail" ? LIMITS.detailBytes : LIMITS.controlBytes;
  if (typeof text !== "string") return { ok: false, error: "invalid_structure" };
  if (text.length > limit || encoder.encode(text).length > limit) return { ok: false, error: "too_large" };
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, error: "invalid_json" }; }
  const result = validate(kind, value);
  return result.ok ? { ok: true, value } : result;
}

module.exports = { LIMITS, validate, parse, safeTree, isRecord };
