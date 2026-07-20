"use strict";

function hasAnswers(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function displayAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return {};
  const output = {};
  for (const [questionId, answer] of Object.entries(answers)) {
    const question = Array.isArray(questions) ? questions.find(item => item?.id === questionId) : null;
    const label = value => {
      const option = Array.isArray(question?.options) ? question.options.find(item => item?.id === value) : null;
      return option?.label || value;
    };
    output[questionId] = Array.isArray(answer) ? answer.map(label) : label(answer);
  }
  return output;
}

function approvalHistoryRecord(event) {
  const entry = event?.entry;
  if (!entry) return null;
  const decision = event.decision && typeof event.decision === "object" ? event.decision : {};
  const option = Array.isArray(entry.options)
    ? entry.options.find(candidate => candidate.id === decision.optionId)
    : null;
  return {
    id: entry.id,
    kind: entry.type === "elicitation" ? "question" : "approval",
    agentId: entry.agentId,
    agentName: entry.agentName,
    sessionId: entry.sessionId,
    title: entry.type === "elicitation" ? "" : entry.description,
    titleKey: entry.type === "elicitation" ? "fallback.agentWaitingInput" : "",
    titleParams: entry.type === "elicitation" ? { agentName: entry.agentName } : {},
    toolName: entry.toolName,
    description: entry.description,
    cwd: entry.cwd,
    toolInput: entry.toolInput,
    questions: entry.questions,
    answers: displayAnswers(entry.questions, decision.answers),
    answerAvailable: hasAnswers(decision.answers),
    outcome: decision.optionId || event.reason || event.state || "unknown",
    outcomeLabel: option?.label || "",
    outcomeLabelKey: option?.labelKey || "",
    outcomeLabelParams: option?.labelParams || {},
    reason: event.reason,
    createdAt: entry.createdAt,
    finalizedAt: event.finalizedAt,
  };
}

function inputHistoryRecord(event) {
  const entry = event?.entry;
  if (!entry) return null;
  const reason = typeof event.reason === "string" ? event.reason : "completed";
  return {
    id: entry.id,
    kind: "question",
    agentId: entry.agentId,
    agentName: entry.agentName,
    sessionId: entry.sessionId,
    title: entry.title,
    titleKey: entry.titleKey,
    titleParams: entry.titleParams,
    description: entry.content,
    cwd: entry.cwd,
    questions: entry.questions,
    answers: event.answers || {},
    answerAvailable: event.answerAvailable === true,
    outcome: reason === "answered" ? "submit" : reason,
    reason,
    content: entry.content,
    contentKey: entry.contentKey,
    contentParams: entry.contentParams,
    createdAt: entry.createdAt,
    finalizedAt: event.finalizedAt,
  };
}

function planHistoryRecord(item) {
  if (!item || item.completionKind !== "plan") return null;
  return {
    id: item.id,
    kind: "plan",
    agentId: item.agentId,
    agentName: item.agentName,
    sessionId: item.sessionId,
    title: item.title,
    titleKey: item.titleKey,
    titleParams: item.titleParams,
    cwd: item.cwd,
    outcome: "ready",
    reason: "shown",
    content: item.output,
    contentKey: item.outputKey,
    contentParams: item.outputParams,
    createdAt: item.createdAt,
    finalizedAt: item.createdAt,
  };
}

module.exports = { approvalHistoryRecord, displayAnswers, hasAnswers, inputHistoryRecord, planHistoryRecord };
