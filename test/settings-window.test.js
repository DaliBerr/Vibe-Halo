"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { agent, listAgents } = require("../src/agent-registry");
const { createLocalizer, catalogDifferences } = require("../src/i18n");
const { InputRequestStore } = require("../src/input-request-store");
const { IntegrationManager } = require("../src/integration-manager");
const { SettingsService, supportedFeatures, validateSettingsAction } = require("../src/settings-service");
const { SettingsStore } = require("../src/settings-store");
const { SettingsWindowController } = require("../src/settings-window-controller");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeIntegrationManager(overrides = {}) {
  const calls = [];
  return {
    calls,
    codexManager: { status: () => ({ feature: "true", trust: { pendingCount: 0 } }), enableFeature() { calls.push(["enableFeature"]); } },
    status: id => ({ detected: id !== "kiro", executable: id === "codex", installed: false, healthy: false, disabled: false, reason: "missing" }),
    paths: id => [`/home/user/.${id}/settings.json`],
    enable(id) { calls.push(["enable", id]); return { ok: true }; },
    disable(id) { calls.push(["disable", id]); return { ok: true }; },
    scan(options) { calls.push(["scan", options]); return []; },
    repairAll() { calls.push(["repairAll"]); return []; },
    uninstallAll() { calls.push(["uninstallAll"]); return []; },
    ...overrides,
  };
}

function serviceFixture(options = {}) {
  const root = tempDir("vibe-halo-settings-service-");
  const settings = new SettingsStore(path.join(root, "settings.json"));
  const integrationManager = options.integrationManager || fakeIntegrationManager();
  const effects = { changed: [], copied: [], ...options.effects };
  const service = new SettingsService({
    settings,
    integrationManager,
    listAgents,
    agent,
    localization: createLocalizer({ preference: options.locale || "en-US" }),
    platform: "win32",
    version: "1.2.3",
    effects: {
      onClientChanged: (id, change) => effects.changed.push([id, change]),
      copyText: value => effects.copied.push(value),
      confirm: async () => options.confirm !== false,
      ...options.effectOverrides,
    },
  });
  return { root, settings, integrationManager, service, effects, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("clients default to off while existing healthy installs migrate as enabled", () => {
  const root = tempDir("vibe-halo-settings-default-");
  try {
    const filePath = path.join(root, "settings.json");
    fs.writeFileSync(filePath, JSON.stringify({
      integrations: {
        codex: { disabledByUser: false, detected: true, installed: true, healthy: true },
        zcode: { disabledByUser: true, detected: true, installed: false },
        qoder: { disabledByUser: false, detected: true, installed: false },
        kiro: { enabled: true, detected: false, installed: false },
      },
    }));
    const settings = new SettingsStore(filePath);
    assert.equal(settings.isClientEnabled("codex"), true);
    assert.equal(settings.isClientEnabled("zcode"), false);
    assert.equal(settings.isClientEnabled("qoder"), false);
    assert.equal(settings.isClientEnabled("kiro"), true);
    assert.equal(settings.isClientEnabled("claude-code"), false);
    assert.equal(settings.getIntegration("claude-code").disabledByUser, true);

    settings.setIntegration("qoder", { disabledByUser: false });
    assert.equal(settings.isClientEnabled("qoder"), true);
    settings.setIntegration("qoder", { reason: "healthy" });
    assert.equal(settings.isClientEnabled("qoder"), true, "status patches keep the user's choice");
    settings.setIntegration("qoder", { enabled: false });
    assert.equal(new SettingsStore(filePath).getIntegration("qoder").disabledByUser, true, "older builds read the off state");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("per-client preferences default on, persist, and reject unknown keys", () => {
  const root = tempDir("vibe-halo-settings-prefs-");
  try {
    const filePath = path.join(root, "settings.json");
    const first = new SettingsStore(filePath);
    assert.deepEqual(first.getClientPreferences("zcode"), { approvals: true, questions: true, reminders: true, completions: true });
    assert.equal(first.setClientPreference("zcode", "approvals", false), true);
    assert.equal(first.setClientPreference("zcode", "bogus", false), false);
    assert.equal(first.setClientPreference("zcode", "completions", "no"), false);
    assert.equal(first.setClientPreference("../evil", "approvals", false), false);
    const second = new SettingsStore(filePath);
    assert.equal(second.getClientPreferences("zcode").approvals, false);
    assert.equal(second.getClientPreferences("zcode").questions, true);
    assert.equal(second.getClientPreferences("codex").approvals, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integration scan installs only clients the user enabled", () => {
  const home = tempDir("vibe-halo-settings-scan-");
  const root = tempDir("vibe-halo-settings-scan-store-");
  try {
    fs.mkdirSync(path.join(home, ".qwen"), { recursive: true });
    fs.mkdirSync(path.join(home, ".qoder"), { recursive: true });
    const hookScriptPath = path.join(root, "vibe-halo-hook.js");
    fs.writeFileSync(hookScriptPath, "");
    const settings = new SettingsStore(path.join(root, "settings.json"));
    settings.setIntegration("qoder", { enabled: true });
    const manager = new IntegrationManager({
      homeDir: home,
      appData: path.join(home, "AppData"),
      platform: "win32",
      executablePath: "C:\\Vibe Halo\\Vibe Halo.exe",
      hookScriptPath,
      backupRoot: path.join(root, "backups"),
      settings,
      codexManager: { ensureCodexDir: () => false, status: () => ({ codexHomeExists: false, events: {}, healthy: false, feature: "unknown" }), install: () => ({ ok: false }), uninstall: () => ({ ok: true }) },
    });
    manager.executableDetected = () => false;
    const results = manager.scan({ install: true });
    const qwen = results.find(item => item.agent.id === "qwen-code");
    const qoder = results.find(item => item.agent.id === "qoder");
    assert.equal(qwen.detected, true);
    assert.equal(qwen.installResult, null);
    assert.equal(fs.existsSync(path.join(home, ".qwen", "settings.json")), false, "detected but disabled clients are left untouched");
    assert.equal(qoder.installResult?.ok, true);
    assert.match(fs.readFileSync(path.join(home, ".qoder", "settings.json"), "utf8"), /vibe-halo-hook\.js/);
    assert.equal(settings.isClientEnabled("qoder"), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings actions are strictly validated", () => {
  assert.deepEqual(validateSettingsAction({ type: "rescan" }), { type: "rescan" });
  assert.deepEqual(validateSettingsAction({ type: "general", key: "approvalEnabled", value: false }), { type: "general", key: "approvalEnabled", value: false });
  assert.deepEqual(validateSettingsAction({ type: "general", key: "language", value: "zh-CN" }), { type: "general", key: "language", value: "zh-CN" });
  assert.equal(validateSettingsAction({ type: "general", key: "language", value: "fr-FR" }), null);
  assert.equal(validateSettingsAction({ type: "general", key: "initialized", value: false }), null);
  assert.equal(validateSettingsAction({ type: "general", key: "approvalEnabled", value: "true" }), null);
  assert.deepEqual(validateSettingsAction({ type: "client-enabled", agentId: "zcode", value: true }, id => !!agent(id)), { type: "client-enabled", agentId: "zcode", value: true });
  assert.equal(validateSettingsAction({ type: "client-enabled", agentId: "nope", value: true }, id => !!agent(id)), null);
  assert.equal(validateSettingsAction({ type: "client-enabled", agentId: "../x", value: true }), null);
  assert.equal(validateSettingsAction({ type: "client-preference", agentId: "zcode", key: "__proto__", value: true }), null);
  assert.equal(validateSettingsAction({ type: "client-preference", agentId: "zcode", key: "approvals", value: 1 }), null);
  assert.equal(validateSettingsAction({ type: "shell", command: "rm -rf /" }), null);
  assert.equal(validateSettingsAction({ type: "rescan", padding: "x".repeat(2000) }), null);
  assert.equal(validateSettingsAction([]), null);
  assert.equal(validateSettingsAction(null), null);
});

test("supported features follow adapter capabilities", () => {
  assert.deepEqual(supportedFeatures(agent("claude-code")), { approvals: true, questions: true, reminders: false, completions: true });
  assert.deepEqual(supportedFeatures(agent("codex")), { approvals: true, questions: false, reminders: true, completions: true });
  assert.deepEqual(supportedFeatures(agent("qoder")), { approvals: false, questions: false, reminders: true, completions: true });
  assert.deepEqual(supportedFeatures(agent("gemini-cli")), { approvals: false, questions: false, reminders: false, completions: true });
});

test("settings state lists every client off by default with localized strings", () => {
  const fixture = serviceFixture({ locale: "zh-CN" });
  try {
    const state = fixture.service.state();
    assert.equal(state.locale, "zh-CN");
    assert.equal(state.strings.general, "通用");
    assert.equal(state.clients.length, listAgents().length);
    assert.equal(state.summary.enabled, 0);
    assert.ok(state.clients.every(client => client.enabled === false && client.status === "off"));
    const kiro = state.clients.find(client => client.id === "kiro");
    assert.equal(kiro.canToggle, false, "undetected clients cannot be switched on");
    const zcode = state.clients.find(client => client.id === "zcode");
    assert.equal(zcode.canToggle, true);
    assert.equal(zcode.features.questions, true);
    assert.equal(state.clients.find(client => client.id === "codex").codex.featureDisabled, false);
    assert.equal(state.general.version, "1.2.3");
  } finally {
    fixture.cleanup();
  }
});

test("client toggles install, remove, and notify the main process", async () => {
  const fixture = serviceFixture();
  try {
    const on = await fixture.service.perform({ type: "client-enabled", agentId: "zcode", value: true });
    assert.equal(on.ok, true);
    assert.deepEqual(fixture.integrationManager.calls.at(-1), ["enable", "zcode"]);
    assert.match(on.message.text, /ZCode is on/);
    const off = await fixture.service.perform({ type: "client-enabled", agentId: "zcode", value: false });
    assert.equal(off.ok, true);
    assert.deepEqual(fixture.integrationManager.calls.at(-1), ["disable", "zcode"]);
    assert.deepEqual(fixture.effects.changed.map(([id, change]) => [id, change.value]), [["zcode", true], ["zcode", false]]);

    const pref = await fixture.service.perform({ type: "client-preference", agentId: "zcode", key: "questions", value: false });
    assert.equal(pref.ok, true);
    assert.equal(fixture.settings.getClientPreferences("zcode").questions, false);
    const unsupported = await fixture.service.perform({ type: "client-preference", agentId: "gemini-cli", key: "approvals", value: false });
    assert.equal(unsupported.ok, false);
    const repairOff = await fixture.service.perform({ type: "client-repair", agentId: "zcode" });
    assert.equal(repairOff.error, "client-disabled");
    const invalid = await fixture.service.perform({ type: "client-enabled", agentId: "zcode", value: "yes" });
    assert.equal(invalid.error, "invalid-action");
  } finally {
    fixture.cleanup();
  }
});

test("failed installs keep the client enabled and report a translated reason", async () => {
  const integrationManager = fakeIntegrationManager({
    enable(id) { this.calls.push(["enable", id]); return { ok: false, reason: "hooks-explicitly-disabled" }; },
  });
  const fixture = serviceFixture({ integrationManager });
  try {
    const result = await fixture.service.perform({ type: "client-enabled", agentId: "qwen-code", value: true });
    assert.equal(result.ok, false);
    assert.equal(result.message.tone, "error");
    assert.match(result.message.text, /Hooks are explicitly disabled by the client/);
  } finally {
    fixture.cleanup();
  }
});

test("destructive general actions require confirmation", async () => {
  const declined = serviceFixture({ confirm: false });
  try {
    await declined.service.perform({ type: "uninstall-all" });
    assert.equal(declined.integrationManager.calls.some(([name]) => name === "uninstallAll"), false);
  } finally {
    declined.cleanup();
  }
  const accepted = serviceFixture();
  try {
    accepted.settings.setIntegration("zcode", { enabled: true });
    const result = await accepted.service.perform({ type: "uninstall-all" });
    assert.equal(result.ok, true);
    assert.equal(accepted.integrationManager.calls.some(([name]) => name === "uninstallAll"), true);
    assert.equal(accepted.settings.isClientEnabled("zcode"), false);
    await accepted.service.perform({ type: "codex-copy-review" });
    assert.deepEqual(accepted.effects.copied, ["/hooks"]);
  } finally {
    accepted.cleanup();
  }
});

test("input reminders can be cleared for one client only", () => {
  const store = new InputRequestStore();
  store.enqueue({ agentId: "qoder", agentName: "Qoder", requestKey: "a", sessionId: "s1", titleKey: "fallback.passiveApprovalTitle" });
  store.enqueue({ agentId: "codex", agentName: "Codex", requestKey: "b", sessionId: "s2", titleKey: "fallback.passiveApprovalTitle" });
  const finalized = [];
  store.on("finalized", event => finalized.push(event.reason));
  assert.equal(store.clearAgent("qoder"), true);
  assert.equal(store.size, 1);
  assert.equal(store.current.agentId, "codex");
  assert.deepEqual(finalized, ["disabled"]);
  assert.equal(store.clearAgent("qoder"), false);
});

function fakeWindowEnvironment() {
  const handlers = new Map();
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "" },
        setWindowOpenHandler: handler => { this.openHandler = handler; },
        send: (channel, value) => this.sent.push([channel, value]),
      });
      windows.push(this);
    }
    loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    focus() {}
    setMenuBarVisibility() {}
    setTitleBarOverlay(value) { this.overlay = value; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true });
  return { FakeWindow, handlers, ipcMain, nativeTheme, windows };
}

test("settings window is sandboxed, opens on a page, and rejects foreign senders", async () => {
  const env = fakeWindowEnvironment();
  const service = {
    t: key => key,
    state: () => ({ clients: [] }),
    perform: async input => ({ ok: true, echoed: input }),
  };
  const controller = new SettingsWindowController({
    BrowserWindow: env.FakeWindow, ipcMain: env.ipcMain, nativeTheme: env.nativeTheme, service, platform: "win32",
    setTimeout: fn => { fn(); return null; }, clearTimeout() {},
  });
  assert.equal(await env.handlers.get("settings:state")({ sender: {} }), null, "no window yet");
  controller.open("zcode");
  const win = env.windows[0];
  const prefs = win.options.webPreferences;
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(win.options.titleBarStyle, "hidden");
  assert.equal(win.options.titleBarOverlay.symbolColor, "#e8eaef");
  assert.deepEqual(win.openHandler(), { action: "deny" });

  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const state = await env.handlers.get("settings:state")(event);
  assert.equal(state.initialPage, "zcode");
  assert.equal((await env.handlers.get("settings:state")(event)).initialPage, null);
  assert.equal((await env.handlers.get("settings:action")({ sender: {} }, { type: "rescan" })).error, "forbidden");
  const foreignFrame = { sender: win.webContents, senderFrame: { url: "https://example.com/" } };
  assert.equal((await env.handlers.get("settings:action")(foreignFrame, { type: "rescan" })).error, "forbidden");
  assert.equal((await env.handlers.get("settings:action")(event, { type: "rescan" })).ok, true);

  win.visible = true;
  controller.open("general");
  assert.equal(env.windows.length, 1, "reopening reuses the window");
  assert.deepEqual(win.sent.at(-1), ["settings:navigate", "general"]);
  controller.open("../../etc");
  assert.deepEqual(win.sent.at(-1), ["settings:navigate", "general"]);
  controller.refresh();
  assert.deepEqual(win.sent.at(-1), ["settings:changed", undefined]);

  env.nativeTheme.shouldUseDarkColors = false;
  env.nativeTheme.emit("updated");
  assert.equal(win.overlay.symbolColor, "#1f2329");
  controller.destroy();
  assert.equal(env.handlers.size, 0);
  assert.equal(win.destroyed, true);
});

test("settings renderer uses a sidebar, safe DOM APIs, themes, and an isolated preload", () => {
  const root = path.resolve(__dirname, "..", "src", "settings-renderer");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  const javascript = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "..", "settings-preload.js"), "utf8");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'/);
  assert.match(html, /<aside class="sidebar"/);
  assert.match(html, /id="client-nav"/);
  assert.match(html, /id="search"/);
  assert.doesNotMatch(javascript, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.match(javascript, /settingsAPI\.action|api\.action\(payload\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /-webkit-app-region:\s*drag/);
  assert.match(css, /\.switch input:checked \+ span/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("settingsAPI"/);
  assert.doesNotMatch(preload, /require\("(?:fs|child_process|path)"\)|shell|clipboard/);
  assert.deepEqual(catalogDifferences(), { missingEnglish: [], missingChinese: [] });
});
