"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.vibeQuestionSubmit = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function zcodeSingleChoiceDecision(item, questions, question, option) {
    if (!item || item.type !== "elicitation" || item.agentId !== "zcode"
      || typeof item.id !== "string" || !item.id
      || !Array.isArray(questions) || questions.length !== 1
      || !question || question.multiSelect === true
      || typeof question.id !== "string" || !question.id
      || !option || typeof option.id !== "string" || !option.id) return null;
    return {
      approvalId: item.id,
      optionId: "submit",
      answers: { [question.id]: option.id },
    };
  }

  function formAnswer(question, selected, text) {
    if (question.answerFormat === "dsh") {
      if (text) return question.multiSelect ? [...selected, `text:${text}`] : `text:${text}`;
      if (!selected.length) return question.allowText ? "skip:" : null;
      return question.multiSelect ? selected : selected[0];
    }
    const values = text ? [...selected, text] : selected;
    return values.length ? (question.multiSelect ? values.slice(0, 20) : values[0]) : null;
  }
  return { zcodeSingleChoiceDecision, formAnswer };
});
