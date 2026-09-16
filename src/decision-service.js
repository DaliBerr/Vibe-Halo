"use strict";

const { validateAnswers } = require("./agent-registry");
const { validate } = require("../packages/protocol");
const { fingerprint } = require("./approval-store");
const { contextDigest, detail, persistent } = require("./remote/event-projector");

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
  constructor({ approvalStore, now, pcId, remoteControlEnabled = () => false, authorizeRemote = () => null } = {}) {
    this.approvals = approvalStore;
    this.now = now || (() => this.approvals.now());
    this.pcId = pcId;
    this.remoteControlEnabled = remoteControlEnabled;
    this.authorizeRemote = authorizeRemote;
    this.receipts = new Map();
    this.quiescing = false;
  }

  decideLocal(payload) {
    const current = this.approvals.current;
    const error = validateDecision(payload, current);
    if (error) return { accepted: false, status: error };
    // Timers may be delayed by a busy event loop. Never extend the deadline.
    if (this.now() >= (current.expiresAt ?? current.createdAt + this.approvals.timeoutMs)) {
      return { accepted: false, status: "expired" };
    }
    // No await between the final current/deadline check and the store mutation.
    try {
      const accepted = this.approvals.resolve(current.id, payload.optionId, {
        ...(payload.optionId === "submit" ? { answers: validateAnswers(current.questions, payload.answers) } : {}),
      });
      return { accepted, status: accepted ? "desktop_accepted" : "already_handled" };
    } catch {
      // A downstream observer can fail after a waiter has already completed.
      // Never retry against the next item or claim client execution succeeded.
      return { accepted: false, status: "result_unknown" };
    }
  }

  returnToNative(approvalId) {
    // Explicit local close is allowed even when the adapter omits a native button.
    const current = this.approvals.current;
    if (!current || current.id !== approvalId) return false;
    return this.approvals.resolve(approvalId, "native");
  }

  quiesceRemote() {
    this.quiescing = true;
  }

  // Internal gateway contract, NOT an authenticated network endpoint. M2 must
  // verify JWS/JWE and supply an opaque principal. The injected synchronous
  // authorizer must reread current PC-local trust and return matching scopes.
  // There is deliberately no production authorizer or transport in M1.
  decideVerifiedRemote(intent, principal) {
    const fail = status => ({ accepted: false, status });
    if (this.quiescing || this.remoteControlEnabled() !== true) return fail("forbidden");
    const shape = validate("decisionIntent", intent);
    if (!shape.ok) return fail(shape.error);
    if (!this.pcId || intent.pcId !== this.pcId) return fail("forbidden");
    const authorization = this.authorizeRemote(principal, intent);
    if (!authorization || authorization.pcId !== this.pcId || authorization.mobileId !== intent.mobileId
      || authorization.bindingId !== intent.bindingId || authorization.bindingRevision !== intent.bindingRevision
      || !Array.isArray(authorization.scopes)) return fail("forbidden");
    if (persistent(intent.optionId)) return fail("forbidden");
    const scope = intent.optionId === "submit" ? "questions.answer" : "approvals.decide";
    if (!authorization.scopes.includes(scope)) return fail("forbidden");
    if (intent.pcSessionEpoch !== this.approvals.pcSessionEpoch) return fail("stale_epoch");

    const now = this.now();
    for (const [key, receipt] of this.receipts) if (receipt.expiresAt <= now) this.receipts.delete(key);
    const key = JSON.stringify([intent.bindingId, intent.mobileId, intent.decisionId]);
    const digest = fingerprint(intent);
    const previous = this.receipts.get(key);
    if (previous) return previous.digest === digest ? { ...previous.result } : fail("decision_conflict");
    // Fail closed at capacity instead of evicting an in-flight idempotency key.
    if (this.receipts.size >= 500) return fail("capacity_exceeded");
    const receipt = { digest, expiresAt: now + 10 * 60_000, result: fail("result_unknown") };
    this.receipts.set(key, receipt);
    const finish = result => { receipt.result = result; return { ...result }; };
    const issuedAt = Date.parse(intent.issuedAt);
    const expiresAt = Date.parse(intent.expiresAt);
    if (issuedAt > now + 5000 || now >= expiresAt || expiresAt - issuedAt > 30_000) return finish(fail("expired"));
    const current = this.approvals.current;
    if (!current) return finish(fail("already_handled"));
    if (current.id !== intent.approvalId) return finish(fail("not_current"));
    if (current.eventId !== intent.eventId || current.eventRevision !== intent.expectedRevision) return finish(fail("stale_revision"));
    if (now >= current.expiresAt || expiresAt > current.expiresAt) return finish(fail("expired"));
    if (contextDigest(current) !== intent.approvalContextDigest) return finish(fail("stale_context"));
    const view = detail(current, {
      pcId: this.pcId, pcSessionEpoch: this.approvals.pcSessionEpoch, currentId: current.id,
      pendingCount: this.approvals.size, now,
    });
    if (!view?.remoteActionable) return finish(fail("detail_incomplete"));
    // All current state, trust, scope, revision, expiry and schema checks above
    // are synchronous. Local validation and finalize occur in the same turn.
    return finish(this.decideLocal({
      approvalId: intent.approvalId, optionId: intent.optionId,
      ...(intent.answers === undefined ? {} : { answers: intent.answers }),
    }));
  }
}

module.exports = { DecisionService, validateDecision, isRecord };
