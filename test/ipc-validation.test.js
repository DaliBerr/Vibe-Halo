"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validCopyPayload, validDecisionPayload, validViewPayload } = require("../src/island-controller");

test("decision payload must match current approval and allowlisted behavior", () => {
  assert.equal(validDecisionPayload({ approvalId: "a", behavior: "allow" }, "a"), true);
  assert.equal(validDecisionPayload({ approvalId: "other", behavior: "allow" }, "a"), false);
  assert.equal(validDecisionPayload({ approvalId: "a", behavior: "always" }, "a"), false);
  assert.equal(validDecisionPayload(null, "a"), false);
});

test("copy payload rejects oversized and non-string values", () => {
  assert.equal(validCopyPayload({ text: "hello" }), true);
  assert.equal(validCopyPayload({ text: "x".repeat(10_001) }), false);
  assert.equal(validCopyPayload({ text: 3 }), false);
});

test("view payload is bound to the current item and validates measured dimensions", () => {
  assert.equal(validViewPayload({ id: "a", action: "expand" }, "a", false), true);
  assert.equal(validViewPayload({ id: "a", action: "collapse" }, "a", true), true);
  assert.equal(validViewPayload({ id: "a", action: "measure", width: 720, height: 580 }, "a", true), true);
  assert.equal(validViewPayload({ id: "other", action: "measure", width: 720, height: 580 }, "a", true), false);
  assert.equal(validViewPayload({ id: "a", action: "measure", width: 720, height: 580 }, "a", false), false);
  assert.equal(validViewPayload({ id: "a", action: "measure", width: 99, height: 580 }, "a", true), false);
  assert.equal(validViewPayload({ id: "a", action: "navigate", width: 720, height: 580 }, "a", true), false);
});
