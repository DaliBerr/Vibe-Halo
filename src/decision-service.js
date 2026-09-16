"use strict";

const { validateAnswers } = require("./agent-registry");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateDecision(payload, current) {
  if (!isRecord(payload) || Object.keys(payload).some(key => !["approvalId", "optionId", "answers"].includes(key))
    || typeof payload.approvalId !== "string" || !payload.approvalId || payload.approvalId.length > 240
    || typeof payload.optionId !== "string" || !payload.optionId || payload.optionId.length > 80) return "invalid_action";
  if (!current) return "already_handled";
  if (payload.approvalId !== current.id) return "not_current";
  if (!current.options?.some(option => option.id === payload.optionId)) return "invalid_action";
  if (payload.optionId === "submit") {
    if (!current.questions?.length || validateAnswers(current.questions, payload.answers) === null) return "invalid_answers";
  } else if (payload.answers !== undefined) return "invalid_answers";
  return null;
}

// Main-process user decisions only. Store timeout/shutdown retain their separate
// native fallback path, including cleanup of entries behind the FIFO head.
class DecisionService {
  constructor({ approvalStore, now } = {}) {
    this.approvals = approvalStore;
    this.now = now || (() => this.approvals.now());
  }

  decideLocal(payload) {
    const current = this.approvals.current;
    const error = validateDecision(payload, current);
    if (error) return { accepted: false, status: error };
    // Timers may be delayed by a busy event loop. Never extend the deadline.
    if (this.now() >= current.createdAt + this.approvals.timeoutMs) {
      return { accepted: false, status: "expired" };
    }
    // No await between the final current/deadline check and the store mutation.
    const accepted = this.approvals.resolve(current.id, payload.optionId, {
      ...(payload.optionId === "submit" ? { answers: validateAnswers(current.questions, payload.answers) } : {}),
    });
    return { accepted, status: accepted ? "desktop_accepted" : "already_handled" };
  }

  returnToNative(approvalId) {
    // Explicit local close is allowed even when the adapter omits a native button.
    const current = this.approvals.current;
    if (!current || current.id !== approvalId) return false;
    return this.approvals.resolve(approvalId, "native");
  }
}

module.exports = { DecisionService, validateDecision, isRecord };
