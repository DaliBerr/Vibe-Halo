"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

const SETTINGS_WINDOW = Object.freeze({ width: 980, height: 680, minWidth: 780, minHeight: 540 });
const SETTINGS_TITLEBAR_HEIGHT = 40;
const SETTINGS_REFRESH_DELAY_MS = 120;
const PAGE_ID = /^(?:general|[a-z0-9-]{1,80})$/;

function titleBarColors(theme) {
  return theme === "dark"
    ? { color: "#00000000", symbolColor: "#e8eaef", height: SETTINGS_TITLEBAR_HEIGHT }
    : { color: "#00000000", symbolColor: "#1f2329", height: SETTINGS_TITLEBAR_HEIGHT };
}

class SettingsWindowController {
  constructor(options) {
    this.BrowserWindow = options.BrowserWindow;
    this.ipcMain = options.ipcMain;
    this.nativeTheme = options.nativeTheme;
    this.service = options.service;
    this.platform = options.platform || process.platform;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.preloadPath = options.preloadPath || path.join(__dirname, "settings-preload.js");
    this.htmlPath = options.htmlPath || path.join(__dirname, "settings-renderer", "index.html");
    this.url = pathToFileURL(this.htmlPath).href;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.window = null;
    this.pendingPage = "general";
    this.refreshTimer = null;
    this.disposers = [];
    this.bind();
  }

  bind() {
    this.ipcMain.handle("settings:state", event => {
      if (!this.validSender(event)) return null;
      return { ...this.service.state(), initialPage: this.takePendingPage() };
    });
    this.ipcMain.handle("settings:action", async (event, input) => {
      if (!this.validSender(event)) return { ok: false, error: "forbidden" };
      try {
        return await this.service.perform(input);
      } catch (error) {
        this.logger.warn("Settings action failed", { message: error.message });
        return { ok: false, error: "operation-failed" };
      }
    });
    this.disposers.push(() => this.ipcMain.removeHandler("settings:state"));
    this.disposers.push(() => this.ipcMain.removeHandler("settings:action"));
    const themeChanged = () => {
      this.applyTitleBar();
      this.refresh();
    };
    this.nativeTheme.on?.("updated", themeChanged);
    this.disposers.push(() => this.nativeTheme.off?.("updated", themeChanged));
  }

  validSender(event) {
    const win = this.window;
    if (!win || win.isDestroyed() || event?.sender !== win.webContents) return false;
    const frame = event.senderFrame;
    if (frame && event.sender.mainFrame && frame !== event.sender.mainFrame) return false;
    return !frame?.url || frame.url === this.url;
  }

  takePendingPage() {
    const page = this.pendingPage;
    this.pendingPage = null;
    return page;
  }

  theme() {
    return this.nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }

  applyTitleBar() {
    const win = this.window;
    if (!win || win.isDestroyed() || this.platform === "darwin" || typeof win.setTitleBarOverlay !== "function") return;
    try { win.setTitleBarOverlay(titleBarColors(this.theme())); } catch {}
  }

  create() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const theme = this.theme();
    const chrome = this.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 14 } }
      : { titleBarStyle: "hidden", titleBarOverlay: titleBarColors(theme) };
    const win = new this.BrowserWindow({
      ...SETTINGS_WINDOW,
      title: this.service.t("settings.windowTitle"),
      show: false,
      center: true,
      autoHideMenuBar: true,
      backgroundColor: theme === "dark" ? "#16181d" : "#f6f7f9",
      ...chrome,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.window = win;
    win.setMenuBarVisibility?.(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("will-attach-webview", event => event.preventDefault());
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    win.on("closed", () => {
      if (this.window === win) this.window = null;
    });
    win.loadURL(this.url);
    return win;
  }

  open(page = "general") {
    const target = typeof page === "string" && PAGE_ID.test(page) ? page : "general";
    const existing = this.window && !this.window.isDestroyed();
    const win = this.create();
    if (existing) {
      win.webContents.send("settings:navigate", target);
      if (win.isMinimized?.()) win.restore();
      win.show();
      win.focus();
    } else {
      this.pendingPage = target;
    }
    return true;
  }

  isOpen() {
    return !!this.window && !this.window.isDestroyed() && this.window.isVisible();
  }

  refresh() {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.refreshTimer) return;
    this.refreshTimer = this.setTimer(() => {
      this.refreshTimer = null;
      if (this.window && !this.window.isDestroyed()) {
        this.window.setTitle?.(this.service.t("settings.windowTitle"));
        this.window.webContents.send("settings:changed");
      }
    }, SETTINGS_REFRESH_DELAY_MS);
    this.refreshTimer?.unref?.();
  }

  destroy() {
    if (this.refreshTimer) this.clearTimer(this.refreshTimer);
    this.refreshTimer = null;
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch {}
    }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = {
  SETTINGS_REFRESH_DELAY_MS,
  SETTINGS_TITLEBAR_HEIGHT,
  SETTINGS_WINDOW,
  SettingsWindowController,
  titleBarColors,
};
