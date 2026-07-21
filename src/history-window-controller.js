"use strict";

const path = require("path");
const { agent } = require("./agent-registry");
const { formatApprovalInput } = require("./approval-presenter");
const { truncateUtf8 } = require("./history-store");
const { translateReason } = require("./i18n");

const HISTORY_GUTTER = Object.freeze({ left: 40, right: 40, top: 28, bottom: 52 });
const HISTORY_WINDOW = Object.freeze({
  contentWidth: 460,
  contentHeight: 720,
  minContentWidth: 360,
  width: 460 + HISTORY_GUTTER.left + HISTORY_GUTTER.right,
  height: 720 + HISTORY_GUTTER.top + HISTORY_GUTTER.bottom,
});
const HISTORY_LEAVE_DELAY_MS = 5000;
const HISTORY_FADE_MS = 220;
const COPY_SECTIONS = new Set(["primary", "parameters", "answers", "content", "cwd"]);
const HISTORY_MAX_DETAIL_IPC_BYTES = 256 * 1024;
const HISTORY_MAX_LIST_IPC_BYTES = 1024 * 1024;

function calculateHistoryBounds(display) {
  const area = display?.workArea || display?.bounds;
  if (!area || !Number.isFinite(area.width) || !Number.isFinite(area.height) || area.width <= 0 || area.height <= 0) return null;
  const usableWidth = Math.max(1, Math.floor(area.width));
  const usableHeight = Math.max(1, Math.floor(area.height));
  const width = Math.min(HISTORY_WINDOW.width, usableWidth);
  const height = Math.min(HISTORY_WINDOW.height, usableHeight);
  return {
    x: Math.round(area.x + area.width - width),
    y: Math.round(area.y),
    width,
    height,
  };
}

function constrainHistoryBounds(bounds, display) {
  const area = display?.workArea || display?.bounds;
  if (!bounds || !area) return null;
  const width = Math.max(1, Math.min(Math.floor(bounds.width || HISTORY_WINDOW.width), Math.floor(area.width)));
  const height = Math.max(1, Math.min(Math.floor(bounds.height || HISTORY_WINDOW.height), Math.floor(area.height)));
  const maximumX = Math.floor(area.x + area.width - width);
  const maximumY = Math.floor(area.y + area.height - height);
  return {
    x: Math.max(Math.floor(area.x), Math.min(Math.round(bounds.x), maximumX)),
    y: Math.max(Math.floor(area.y), Math.min(Math.round(bounds.y), maximumY)),
    width,
    height,
  };
}

function boundsKey(bounds) {
  return bounds ? `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}` : "";
}

function validId(value) {
  return typeof value === "string" && /^[0-9a-f-]{16,80}$/i.test(value);
}

function localizeValue(localization, value, key, params) {
  return value || (key ? localization.t(key, params) : "");
}

function outcomeKey(record) {
  if (record.reason === "timeout" || record.reason === "expired") return "outcomeTimeout";
  if (record.reason === "all-waiters-disconnected" || record.reason === "disconnected") return "outcomeDisconnected";
  if (record.reason === "dismissed") return "outcomeDismissed";
  if (["user-closed", "window-close", "shutdown", "cleared", "disabled"].includes(record.reason)) return "outcomeClosed";
  if (record.outcome === "allow" || record.outcome === "always") return "outcomeAllow";
  if (record.outcome === "deny") return "outcomeDeny";
  if (record.outcome === "submit" || record.outcome === "answered") return "outcomeSubmit";
  if (record.outcome === "native") return "outcomeNative";
  if (record.outcome === "ready") return "outcomeReady";
  if (["answered", "session-stopped", "new-prompt"].includes(record.reason)) return "outcomeCompleted";
  return "outcomeUnknown";
}

function localizeRecord(localization, record) {
  const descriptor = agent(record.agentId);
  const title = localizeValue(localization, record.title, record.titleKey, record.titleParams);
  const outcomeLabel = localizeValue(localization, record.outcomeLabel, record.outcomeLabelKey, record.outcomeLabelParams)
    || localization.historyStrings()[outcomeKey(record)];
  return {
    ...record,
    title,
    outcomeLabel,
    reasonLabel: translateReason(localization, record.reason),
    agentAppearance: descriptor?.appearance || {
      glyph: "A", accent: "#64748B", inkLight: "#334155", inkDark: "#CBD5E1",
    },
  };
}

function historyListState(store, localization, nativeTheme) {
  const snapshot = store.snapshot();
  const state = {
    locale: localization.locale,
    theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    strings: localization.historyStrings(),
    storage: {
      count: snapshot.count,
      mode: snapshot.mode,
      retentionDays: snapshot.retentionDays,
      maxEntries: snapshot.maxEntries,
    },
    items: store.list().map(record => localizeRecord(localization, record)),
  };
  while (state.items.length && Buffer.byteLength(JSON.stringify(state), "utf8") > HISTORY_MAX_LIST_IPC_BYTES) state.items.pop();
  return state;
}

function historyDetail(store, localization, id) {
  const record = store.get(id);
  if (!record) return null;
  const localized = localizeRecord(localization, record);
  const t = (key, params) => localization.t(key, params);
  let presentation = null;
  if (record.kind === "approval" || (record.kind === "question" && Object.keys(record.toolInput || {}).length)) {
    presentation = formatApprovalInput(record.toolInput, record.description, t);
    const primaryKey = ["command", "cmd", "script", "patch", "diff", "query", "search_query", "prompt", "question", "url", "uri", "file_path", "path", "input", "text"]
      .find(key => typeof record.toolInput?.[key] === "string" && record.toolInput[key]);
    const raw = JSON.stringify(record.toolInput || {}, null, 2);
    presentation = {
      ...presentation,
      primary: primaryKey ? record.toolInput[primaryKey] : presentation.primary,
      copyText: primaryKey ? record.toolInput[primaryKey] : raw,
      raw,
      hasRaw: raw !== "{}",
    };
    delete presentation.copyText;
  }
  const content = localizeValue(localization, record.content, record.contentKey, record.contentParams);
  const detail = {
    ...localized,
    toolInput: undefined,
    presentation,
    content,
    answersText: Object.keys(record.answers || {}).length ? JSON.stringify(record.answers, null, 2) : "",
  };
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") > HISTORY_MAX_DETAIL_IPC_BYTES) {
    const overflow = Buffer.byteLength(JSON.stringify(detail), "utf8") - HISTORY_MAX_DETAIL_IPC_BYTES;
    if (detail.presentation?.raw) detail.presentation.raw = truncateUtf8(detail.presentation.raw, Math.max(0, Buffer.byteLength(detail.presentation.raw, "utf8") - overflow - 1024));
    detail.truncated = true;
  }
  return detail;
}

function copyValue(detail, section) {
  if (!detail || !COPY_SECTIONS.has(section)) return "";
  if (section === "primary") return detail.presentation?.primary || "";
  if (section === "parameters") return detail.presentation?.raw || "";
  if (section === "answers") return detail.answersText || "";
  if (section === "content") return detail.content || "";
  if (section === "cwd") return detail.cwd || "";
  return "";
}

class HistoryWindowController {
  constructor(options) {
    this.BrowserWindow = options.BrowserWindow;
    this.screen = options.screen;
    this.nativeTheme = options.nativeTheme;
    this.ipcMain = options.ipcMain;
    this.clipboard = options.clipboard;
    this.dialog = options.dialog;
    this.store = options.historyStore;
    this.localization = options.localization;
    this.platformAdapter = options.platformAdapter || null;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.onChanged = options.onChanged || (() => {});
    this.preloadPath = options.preloadPath || path.join(__dirname, "history-preload.js");
    this.htmlPath = options.htmlPath || path.join(__dirname, "history-renderer", "index.html");
    this.leaveDelayMs = Number.isFinite(options.leaveDelayMs) ? options.leaveDelayMs : HISTORY_LEAVE_DELAY_MS;
    this.fadeMs = Number.isFinite(options.fadeMs) ? options.fadeMs : HISTORY_FADE_MS;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.window = null;
    this.currentDisplayId = null;
    this.leaveTimer = null;
    this.hideTimer = null;
    this.manualClosing = false;
    this.customBounds = null;
    this.lastProgrammaticBounds = "";
    this.disposers = [];
    this.bound = false;
  }

  create() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new this.BrowserWindow({
      width: HISTORY_WINDOW.width,
      height: HISTORY_WINDOW.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = win;
    this.platformAdapter?.configureWindow?.(win);
    try { win.setAlwaysOnTop(true, "floating"); } catch {}
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.on("close", event => {
      if (!win.__allowClose) {
        event.preventDefault();
        this.close(true);
      }
    });
    win.on("moved", () => this.captureMovedBounds());
    win.loadFile(this.htmlPath);
    if (!this.bound) this.bind();
    return win;
  }

  bind() {
    this.bound = true;
    const handle = (channel, handler) => {
      this.ipcMain.handle(channel, async (event, payload) => {
        if (!this.validSender(event)) return null;
        return handler(payload);
      });
      this.disposers.push(() => this.ipcMain.removeHandler(channel));
    };
    handle("history:list", () => this.state());
    handle("history:get", payload => validId(payload?.id) ? historyDetail(this.store, this.localization, payload.id) : null);
    handle("history:delete", async payload => {
      if (!validId(payload?.id) || !this.store.get(payload.id)) return false;
      if (!await this.confirm("history.deleteConfirm", "history.deleteDetail")) return false;
      return this.store.remove(payload.id);
    });
    handle("history:clear", async () => {
      if (!this.store.snapshot().count) return false;
      if (!await this.confirm("history.clearConfirm", "history.clearDetail")) return false;
      return this.store.clear("user-cleared");
    });
    handle("history:copy", payload => {
      if (!validId(payload?.id) || !COPY_SECTIONS.has(payload?.section)) return false;
      const value = copyValue(historyDetail(this.store, this.localization, payload.id), payload.section);
      if (!value) return false;
      this.clipboard.writeText(truncateUtf8(value, 128 * 1024));
      return true;
    });
    const onPointer = (event, payload) => {
      if (!this.validSender(event) || typeof payload?.inside !== "boolean") return;
      if (payload.inside) this.cancelClose();
      else this.scheduleClose();
    };
    const onClose = event => {
      if (this.validSender(event)) this.close(true);
    };
    this.ipcMain.on("history:pointer", onPointer);
    this.ipcMain.on("history:close", onClose);
    this.disposers.push(() => this.ipcMain.removeListener("history:pointer", onPointer));
    this.disposers.push(() => this.ipcMain.removeListener("history:close", onClose));

    const changed = () => {
      this.refresh();
      this.onChanged();
    };
    const themeChanged = () => this.refresh();
    this.store.on("changed", changed);
    this.nativeTheme.on("updated", themeChanged);
    this.disposers.push(() => this.store.off("changed", changed));
    this.disposers.push(() => this.nativeTheme.off("updated", themeChanged));
    const displayChanged = () => this.refreshBounds();
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
      this.screen.on(event, displayChanged);
      this.disposers.push(() => this.screen.off(event, displayChanged));
    }
  }

  validSender(event) {
    return !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  async confirm(messageKey, detailKey) {
    const options = {
      type: "warning",
      buttons: [this.localization.t("dialog.cancel"), this.localization.t(messageKey.includes("clear") ? "history.clear" : "history.delete")],
      defaultId: 0,
      cancelId: 0,
      title: this.localization.t("history.title"),
      message: this.localization.t(messageKey),
      detail: this.localization.t(detailKey),
    };
    const result = this.window ? await this.dialog.showMessageBox(this.window, options) : await this.dialog.showMessageBox(options);
    return result.response === 1;
  }

  state() {
    return historyListState(this.store, this.localization, this.nativeTheme);
  }

  refresh() {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("history:changed");
  }

  open() {
    const win = this.create();
    this.manualClosing = false;
    this.cancelClose();
    const referencePoint = this.customBounds
      ? { x: this.customBounds.x + this.customBounds.width / 2, y: this.customBounds.y + this.customBounds.height / 2 }
      : this.screen.getCursorScreenPoint();
    const display = this.screen.getDisplayNearestPoint(referencePoint) || this.screen.getPrimaryDisplay();
    this.currentDisplayId = display?.id ?? null;
    const bounds = this.customBounds
      ? constrainHistoryBounds(this.customBounds, display)
      : calculateHistoryBounds(display);
    if (bounds) this.setWindowBounds(bounds);
    win.webContents.send("history:reset");
    win.show();
    win.focus();
    return true;
  }

  refreshBounds() {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const displays = this.screen.getAllDisplays?.() || [];
    const display = displays.find(item => item.id === this.currentDisplayId) || this.screen.getPrimaryDisplay();
    this.currentDisplayId = display?.id ?? null;
    const bounds = this.customBounds
      ? constrainHistoryBounds(win.getBounds(), display)
      : calculateHistoryBounds(display);
    if (bounds) {
      if (this.customBounds) this.customBounds = bounds;
      this.setWindowBounds(bounds);
    }
  }

  setWindowBounds(bounds) {
    if (!this.window || this.window.isDestroyed() || !bounds) return;
    this.lastProgrammaticBounds = boundsKey(bounds);
    this.window.setBounds(bounds, false);
  }

  captureMovedBounds() {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible() || typeof win.getBounds !== "function") return;
    const current = win.getBounds();
    if (boundsKey(current) === this.lastProgrammaticBounds) {
      this.lastProgrammaticBounds = "";
      return;
    }
    const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
    const display = this.screen.getDisplayNearestPoint(center) || this.screen.getPrimaryDisplay();
    const constrained = constrainHistoryBounds(current, display);
    if (!constrained) return;
    this.currentDisplayId = display?.id ?? null;
    this.customBounds = constrained;
    if (boundsKey(current) !== boundsKey(constrained)) this.setWindowBounds(constrained);
  }

  scheduleClose() {
    if (!this.window?.isVisible?.() || this.manualClosing) return;
    if (this.leaveTimer) this.clearTimer(this.leaveTimer);
    this.leaveTimer = this.setTimer(() => {
      this.leaveTimer = null;
      this.fadeAndHide();
    }, this.leaveDelayMs);
    this.leaveTimer?.unref?.();
  }

  cancelClose() {
    if (this.manualClosing) return;
    if (this.leaveTimer) this.clearTimer(this.leaveTimer);
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.leaveTimer = null;
    this.hideTimer = null;
    if (!this.manualClosing) this.window?.webContents?.send?.("history:fade", false);
  }

  close(manual = false) {
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return false;
    this.manualClosing = manual;
    this.cancelTimers();
    this.fadeAndHide();
    return true;
  }

  fadeAndHide() {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.webContents.send("history:fade", true);
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.hideTimer = this.setTimer(() => {
      this.hideTimer = null;
      if (!win.isDestroyed()) win.hide();
      this.manualClosing = false;
    }, this.fadeMs);
    this.hideTimer?.unref?.();
  }

  cancelTimers() {
    if (this.leaveTimer) this.clearTimer(this.leaveTimer);
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.leaveTimer = null;
    this.hideTimer = null;
  }

  destroy() {
    this.cancelTimers();
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch {}
    }
    this.bound = false;
    if (this.window && !this.window.isDestroyed()) {
      this.window.__allowClose = true;
      this.window.destroy();
    }
    this.window = null;
  }
}

module.exports = {
  COPY_SECTIONS,
  HISTORY_FADE_MS,
  HISTORY_LEAVE_DELAY_MS,
  HISTORY_MAX_DETAIL_IPC_BYTES,
  HISTORY_MAX_LIST_IPC_BYTES,
  HISTORY_GUTTER,
  HISTORY_WINDOW,
  HistoryWindowController,
  calculateHistoryBounds,
  constrainHistoryBounds,
  copyValue,
  historyDetail,
  historyListState,
  outcomeKey,
  validId,
};
