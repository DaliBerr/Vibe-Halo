"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { IslandController } = require("../src/island-controller");

function inputItem(id = "input-new") {
  return {
    id,
    type: "input-request",
    agentId: "codex",
    agentName: "Codex",
    sessionId: "codex-session",
    title: "Question",
    content: "Return to Codex",
    questions: [],
    expanded: false,
    createdAt: Date.now(),
    sourcePid: 42,
    pidChain: [42, 21],
  };
}

test("a new input reminder drops stale display state and rises without focus", async () => {
  const cursorDisplay = { id: "cursor", workArea: { x: 0, y: 10, width: 1000, height: 800 } };
  const sourceDisplay = { id: "source", workArea: { x: 1000, y: 20, width: 1200, height: 900 } };
  const item = inputItem();
  const bounds = [];
  const sent = [];
  let visible = false;
  let showInactiveCount = 0;
  let moveTopCount = 0;
  let focusCount = 0;
  let alwaysOnTopCount = 0;
  const win = {
    webContents: { send: (...args) => sent.push(args) },
    isDestroyed: () => false,
    isVisible: () => visible,
    showInactive() { visible = true; showInactiveCount += 1; },
    moveTop() { moveTopCount += 1; },
    focus() { focusCount += 1; },
    setAlwaysOnTop() { alwaysOnTopCount += 1; },
    setBounds(value) { bounds.push(value); },
    hide() { visible = false; },
  };
  const controller = new IslandController({
    BrowserWindow: function BrowserWindow() {},
    screen: {
      getCursorScreenPoint: () => ({ x: 50, y: 50 }),
      getDisplayNearestPoint: () => cursorDisplay,
      getPrimaryDisplay: () => cursorDisplay,
    },
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {},
    clipboard: {},
    approvalStore: { current: null, snapshot: () => ({ current: null, pendingCount: 0 }) },
    inputRequestStore: { current: item, snapshot: () => ({ current: item, pendingCount: 1 }) },
    completionStore: { current: null, snapshot: () => null },
    locateDisplay: async (_screen, entry) => {
      assert.equal(entry.sourcePid, 42);
      return sourceDisplay;
    },
  });
  controller.window = win;
  controller.currentDisplay = { id: "stale", workArea: { x: -1200, y: 0, width: 1200, height: 800 } };
  controller.measuredCurrentId = "old-item";

  controller.refresh("queued");
  assert.deepEqual(bounds[0], { x: 326, y: 10, width: 348, height: 88 });
  assert.equal(showInactiveCount, 1);
  assert.equal(moveTopCount, 1);
  assert.equal(alwaysOnTopCount, 1);
  assert.equal(focusCount, 0);
  assert.equal(sent.at(-1)[1].mode, "input-request-compact");

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bounds.at(-1), { x: 1426, y: 20, width: 348, height: 88 });

  controller.refresh("theme");
  assert.equal(moveTopCount, 1);
  assert.equal(focusCount, 0);
});
