"use strict";

const { fingerprint } = require("../approval-store");
const { sanitizeValue } = require("../history-store");
const { agent } = require("../agent-registry");
const { validate, LIMITS } = require("../../packages/protocol");

function contextDigest(entry) {
  return `sha256:${fingerprint({
    agentId: entry.agentId, kind: entry.kind || entry.type, toolName: entry.toolName,
    toolInput: entry.toolInput, description: entry.description, cwd: entry.cwd,
    options: entry.options, questions: entry.questions,
  })}`;
}

function persistent(optionId) {
  return optionId === "always" || optionId.startsWith("suggestion:");
}

function summary(entry, { pcId, pcSessionEpoch, currentId, pendingCount, now }) {
  const expired = now >= entry.expiresAt && entry.state === "pending";
  const isQuestion = (entry.kind || entry.type) === "elicitation";
  const value = {
    protocolVersion: 1, eventId: entry.eventId, pcId, pcSessionEpoch,
    streamSeq: entry.streamSeq, eventRevision: entry.eventRevision,
    kind: isQuestion ? "question" : "approval", agentId: entry.agentId,
    createdAt: new Date(entry.createdAt).toISOString(), expiresAt: new Date(entry.expiresAt).toISOString(),
    state: entry.state,
    actionable: entry.state === "pending" && entry.id === currentId && !expired,
    pendingCount, summaryKey: isQuestion ? "remote.questionRequested" : "remote.approvalRequested",
  };
  return validate("eventSummary", value).ok ? value : null;
}

// Detail is plaintext for the future authenticated sign-then-encrypt gateway.
// Never send this object as a push payload or directly to a transport.
function detail(entry, context) {
  const eventSummary = summary(entry, context);
  if (!eventSummary) return null;
  const sanitized = sanitizeValue(entry.toolInput, "toolInput");
  const redacted = JSON.stringify(sanitized) !== JSON.stringify(entry.toolInput);
  const toolInputText = JSON.stringify(sanitized);
  const value = {
    protocolVersion: 1, summary: eventSummary, approvalId: entry.id,
    approvalContextDigest: contextDigest(entry), toolName: entry.toolName,
    toolInputText, description: entry.description,
    options: entry.options.map(option => ({
      id: option.id, label: option.label || "", labelKey: option.labelKey || "", tone: option.tone,
    })),
    questions: entry.questions.map(question => ({
      id: question.id, header: question.header, question: question.question, questionKey: question.questionKey,
      multiSelect: question.multiSelect, allowText: question.allowText,
      options: question.options.map(option => ({ id: option.id, label: option.label, description: option.description })),
    })),
    truncated: entry.remoteContextComplete !== true, redacted,
    remoteActionable: false, pcTime: new Date(context.now).toISOString(),
  };
  const capabilities = agent(entry.agentId)?.capabilities;
  value.remoteActionable = eventSummary.actionable && !value.truncated && !redacted
    && (eventSummary.kind === "question" ? capabilities?.elicitation === true : capabilities?.approval === true);
  // No complete persistent preview exists yet. Do not expose these options as
  // phone actions; the service independently rejects forged persistent intents.
  value.options = value.options.filter(option => !persistent(option.id));
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > LIMITS.detailBytes) {
    value.toolInputText = "";
    value.description = "";
    value.questions = [];
    value.options = [];
    value.truncated = true;
    value.remoteActionable = false;
  }
  return validate("eventDetail", value).ok ? value : null;
}

function queueView(store, { pcId, offset = 0, limit = 100 } = {}) {
  const page = store.listPending({ offset, limit });
  const context = { pcId, pcSessionEpoch: page.pcSessionEpoch, currentId: store.current?.id, pendingCount: page.pendingCount, now: store.now() };
  const value = {
    protocolVersion: 1, pcId, pcSessionEpoch: page.pcSessionEpoch, streamSeq: page.streamSeq,
    pendingCount: page.pendingCount, offset,
    nextOffset: null, events: [],
  };
  let consumed = 0;
  for (const entry of page.entries) {
    const event = summary(entry, context);
    if (event) value.events.push(event);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > LIMITS.detailBytes - 100) {
      if (event) value.events.pop();
      break;
    }
    consumed += 1;
  }
  value.nextOffset = offset + consumed < page.pendingCount ? offset + consumed : null;
  return value;
}

module.exports = { contextDigest, persistent, summary, detail, queueView };
