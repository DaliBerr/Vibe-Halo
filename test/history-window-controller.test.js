"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createLocalizer } = require("../src/i18n");
const { HistoryStore } = require("../src/history-store");
const {
  HistoryWindowController,
  HISTORY_MAX_DETAIL_IPC_BYTES,
  HISTORY_MAX_LIST_IPC_BYTES,
  HISTORY_GUTTER,
  HISTORY_WINDOW,
  calculateHistoryBounds,
  constrainHistoryBounds,
  historyDetail,
  historyListState,
  outcomeKey,
  validId,
} = require("../src/history-window-controller");

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

class FakeIpc extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(channel, handler) { this.handlers.set(channel, handler); }
  removeHandler(channel) { this.handlers.delete(channel); }
  invoke(channel, event, payload) { return this.handlers.get(channel)(event, payload); }
}

class FakeWebContents extends EventEmitter {
  constructor() { super(); this.messages = []; this.openHandler = null; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  send(...args) { this.messages.push(args); }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.bounds = null;
    this.alwaysOnTop = null;
  }
  setAlwaysOnTop(...args) { this.alwaysOnTop = args; }
  setMenuBarVisibility() {}
  loadFile(value) { this.file = value; }
  setBounds(value) { this.bounds = value; }
  getBounds() { return { ...this.bounds }; }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

function controllerFixture() {
  const ipcMain = new FakeIpc();
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  const screen = new EventEmitter();
  const display = { id: 1, workArea: { x: 100, y: 50, width: 1200, height: 800 } };
  screen.getCursorScreenPoint = () => ({ x: 200, y: 100 });
  screen.getDisplayNearestPoint = () => display;
  screen.getPrimaryDisplay = () => display;
  screen.getAllDisplays = () => [display];
  const timers = new Map();
  let nextTimer = 1;
  const controller = new HistoryWindowController({
    BrowserWindow: FakeWindow,
    clipboard: { values: [], writeText(value) { this.values.push(value); } },
    dialog: { async showMessageBox() { return { response: 1 }; } },
    historyStore: storeFixture(),
    ipcMain,
    localization: createLocalizer({ preference: "en-US", systemLocale: "en-US" }),
    nativeTheme,
    screen,
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { controller, ipcMain, nativeTheme, screen, timers };
}

test("history bounds stay pinned to the right and clamp small work areas", () => {
  assert.deepEqual(calculateHistoryBounds({ workArea: { x: 100, y: 50, width: 1200, height: 800 } }), {
    x: 760, y: 50, width: 540, height: 800,
  });
  assert.deepEqual(calculateHistoryBounds({ workArea: { x: 0, y: 0, width: 330, height: 500 } }), {
    x: 0, y: 0, width: 330, height: 500,
  });
  assert.deepEqual(HISTORY_GUTTER, { left: 40, right: 40, top: 28, bottom: 52 });
  assert.equal(HISTORY_WINDOW.contentWidth, 460);
  assert.deepEqual(constrainHistoryBounds(
    { x: -500, y: 900, width: 540, height: 800 },
    { workArea: { x: 100, y: 50, width: 1200, height: 800 } },
  ), { x: 100, y: 50, width: 540, height: 800 });
  assert.equal(calculateHistoryBounds(null), null);
});

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

test("isolated IPC validates sender, ids, copy regions, and supports deletion", async () => {
  const { controller, ipcMain } = controllerFixture();
  const win = controller.create();
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.movable, true);
  assert.deepEqual(win.alwaysOnTop, [true, "floating"]);
  assert.deepEqual(win.webContents.openHandler(), { action: "deny" });
  assert.equal(await ipcMain.invoke("history:list", { sender: {} }), null);
  const event = { sender: win.webContents };
  assert.equal((await ipcMain.invoke("history:list", event)).items.length, 1);
  assert.equal(await ipcMain.invoke("history:get", event, { id: "../../settings.json" }), null);
  assert.equal(await ipcMain.invoke("history:copy", event, { id: RECORD_ID, section: "arbitrary" }), false);
  assert.equal(await ipcMain.invoke("history:copy", event, { id: RECORD_ID, section: "primary" }), true);
  assert.equal(await ipcMain.invoke("history:delete", event, { id: RECORD_ID }), true);
  assert.equal(await ipcMain.invoke("history:delete", event, { id: RECORD_ID }), false);
  controller.destroy();
  assert.equal(ipcMain.handlers.size, 0);
});

test("opening resets the list and pointer leave fades after five seconds", () => {
  const { controller, ipcMain, timers } = controllerFixture();
  controller.open();
  const win = controller.window;
  assert.equal(win.visible, true);
  assert.deepEqual(win.bounds, { x: 760, y: 50, width: 540, height: 800 });
  assert.ok(win.webContents.messages.some(message => message[0] === "history:reset"));
  ipcMain.emit("history:pointer", { sender: win.webContents }, { inside: false });
  const leave = [...timers.values()].find(timer => timer.delay === 5000);
  assert.ok(leave);
  leave.callback();
  assert.ok(win.webContents.messages.some(message => message[0] === "history:fade" && message[1] === true));
  const fade = [...timers.values()].find(timer => timer.delay === 220);
  assert.ok(fade);
  fade.callback();
  assert.equal(win.visible, false);
  controller.destroy();
});

test("pointer re-entry cancels auto-hide and manual close still fades", () => {
  const { controller, ipcMain, timers } = controllerFixture();
  controller.open();
  const win = controller.window;
  ipcMain.emit("history:pointer", { sender: win.webContents }, { inside: false });
  assert.ok([...timers.values()].some(timer => timer.delay === 5000));
  ipcMain.emit("history:pointer", { sender: win.webContents }, { inside: true });
  assert.equal([...timers.values()].some(timer => timer.delay === 5000), false);
  ipcMain.emit("history:close", { sender: win.webContents });
  const fade = [...timers.values()].find(timer => timer.delay === 220);
  assert.ok(fade);
  fade.callback();
  assert.equal(win.visible, false);
  controller.destroy();
});

test("display removal constrains a visible history window to the primary work area", () => {
  const { controller, screen } = controllerFixture();
  controller.open();
  const fallback = { id: 2, workArea: { x: -800, y: 10, width: 800, height: 600 } };
  screen.getAllDisplays = () => [];
  screen.getPrimaryDisplay = () => fallback;
  screen.emit("display-removed", {}, { id: 1 });
  assert.deepEqual(controller.window.bounds, { x: -540, y: 10, width: 540, height: 600 });
  controller.destroy();
});

test("native header dragging preserves the custom position and clamps it to the work area", () => {
  const { controller, timers } = controllerFixture();
  controller.open();
  const win = controller.window;
  win.emit("moved");
  win.bounds = { x: 320, y: 50, width: 540, height: 800 };
  win.emit("moved");
  assert.deepEqual(controller.customBounds, win.bounds);
  controller.close(true);
  [...timers.values()].find(timer => timer.delay === 220).callback();
  controller.open();
  assert.deepEqual(win.bounds, { x: 320, y: 50, width: 540, height: 800 });
  win.emit("moved");
  win.bounds = { x: -1000, y: -1000, width: 540, height: 800 };
  win.emit("moved");
  assert.deepEqual(win.bounds, { x: 100, y: 50, width: 540, height: 800 });
  controller.destroy();
});

test("ids must remain bounded and opaque", () => {
  assert.equal(validId(RECORD_ID), true);
  assert.equal(validId("id-1"), false);
  assert.equal(validId("a".repeat(81)), false);
});
