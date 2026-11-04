"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalizer } = require("../src/i18n");
const { HistoryStore } = require("../src/history-store");
const {
  HISTORY_MAX_DETAIL_IPC_BYTES,
  HISTORY_MAX_LIST_IPC_BYTES,
  copyValue,
  historyDetail,
  historyListState,
  outcomeKey,
  validId,
} = require("../src/history-presenter");

const RECORD_ID = "11111111-1111-4111-8111-111111111111";

function record(overrides = {}) {
  const now = Date.now();
  return {
    id: RECORD_ID,
    kind: "approval",
    agentId: "zcode",
    agentName: "ZCode",
    sessionId: "session",
    toolName: "Bash",
    description: "Run tests",
    cwd: "/repo",
    toolInput: { command: "npm test", password: "hidden", nested: { timeout_ms: 1000 } },
    outcome: "allow",
    reason: "allow",
    createdAt: now - 10,
    finalizedAt: now,
    ...overrides,
  };
}

function storeFixture() {
  const store = new HistoryStore({ filePath: "", safeStorage: null });
  store.load();
  store.append(record());
  return store;
}

test("localized list and detail preserve full sanitized parameters", () => {
  const store = storeFixture();
  const localization = createLocalizer({ preference: "en-US", systemLocale: "en-US" });
  const state = historyListState(store, localization, { shouldUseDarkColors: false });
  assert.equal(state.theme, "light");
  assert.equal(Object.hasOwn(state.storage, "filePath"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= HISTORY_MAX_LIST_IPC_BYTES);
  assert.equal(state.items[0].outcomeLabel, "Allowed once");
  assert.equal(state.items[0].agentAppearance.glyph, "Z");
  const detail = historyDetail(store, localization, RECORD_ID);
  assert.equal(detail.presentation.primary, "npm test");
  assert.match(detail.presentation.raw, /"password": "\[REDACTED\]"/);
  assert.match(detail.presentation.raw, /"timeout_ms": 1000/);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= HISTORY_MAX_DETAIL_IPC_BYTES);
  assert.equal(outcomeKey({ outcome: "native", reason: "timeout" }), "outcomeTimeout");
});

test("ids must remain bounded and opaque", () => {
  assert.equal(validId(RECORD_ID), true);
  assert.equal(validId("id-1"), false);
  assert.equal(validId("a".repeat(81)), false);
});

test("copy regions are limited to known detail sections", () => {
  const store = storeFixture();
  const localization = createLocalizer({ preference: "en-US", systemLocale: "en-US" });
  const detail = historyDetail(store, localization, RECORD_ID);
  assert.equal(copyValue(detail, "primary"), "npm test");
  assert.equal(copyValue(detail, "cwd"), "/repo");
  assert.equal(copyValue(detail, "arbitrary"), "");
  assert.equal(copyValue(null, "primary"), "");
});
