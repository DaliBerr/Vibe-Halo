"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { zcodeSingleChoiceDecision } = require("../src/renderer/question-submit");

test("ZCode single-choice questions submit immediately with a bounded answer", () => {
  const question = {
    id: "question_1",
    multiSelect: false,
    options: [{ id: "option_1" }, { id: "option_2" }, { id: "option_3" }],
  };
  assert.deepEqual(zcodeSingleChoiceDecision(
    { id: "approval-1", type: "elicitation", agentId: "zcode" },
    [question],
    question,
    question.options[1],
  ), {
    approvalId: "approval-1",
    optionId: "submit",
    answers: { question_1: "option_2" },
  });
});

test("immediate submit stays scoped to one ZCode single-select question", () => {
  const question = { id: "q", multiSelect: false };
  const item = { id: "a", type: "elicitation", agentId: "zcode" };
  assert.equal(zcodeSingleChoiceDecision({ ...item, agentId: "claude-code" }, [question], question, { id: "o" }), null);
  assert.equal(zcodeSingleChoiceDecision(item, [question, question], question, { id: "o" }), null);
  assert.equal(zcodeSingleChoiceDecision(item, [question], { ...question, multiSelect: true }, { id: "o" }), null);
  assert.equal(zcodeSingleChoiceDecision(item, [question], question, { id: "" }), null);
});
