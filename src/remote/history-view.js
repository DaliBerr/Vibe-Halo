"use strict";
const { truncateUtf8 } = require("../history-store");
const clip = (value, bytes = 640) => truncateUtf8(typeof value === "string" ? value : "", bytes);
function historyView(record, details = false) {
  const input = record.toolInput || {};
  const question = record.questions?.[0]?.question;
  const operation = [input.command, input.cmd, input.path, input.file_path, input.query].find(value => typeof value === "string" && value.trim());
  const preview = record.summary || question || operation || record.content || record.description || record.title || record.toolName;
  const view = { viewVersion: 2, id: record.id, kind: record.kind, agentId: record.agentId,
    agentName: clip(record.agentName, 240), title: clip(record.title), toolName: clip(record.toolName, 240),
    projectName: clip((record.cwd || "").replace(/\\/g, "/").replace(/\/$/, "").split("/").pop(), 240),
    sessionLabel: clip(record.sessionId, 80), preview: clip(preview), outcome: record.outcome,
    outcomeLabel: clip(record.outcomeLabel, 240), createdAt: record.createdAt, finalizedAt: record.finalizedAt,
    truncated: record.truncated === true };
  if (details) {
    view.excerpt = clip(question || operation || record.content || record.description || preview, 2400);
    view.questions = (record.questions || []).slice(0, 10).map(item => ({ question: clip(item.question || item.header, 800),
      answer: clip([record.answers?.[item.id]].flat().filter(value => typeof value === "string").join(" · "), 800) }));
    view.answerAvailable = record.answerAvailable === true;
    view.truncated ||= Buffer.byteLength(String(question || operation || record.content || record.description || preview || "")) > 2400;
  }
  return view;
}
module.exports = { historyView };
