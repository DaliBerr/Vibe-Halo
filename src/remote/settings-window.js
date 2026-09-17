"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { safeTree } = require("../../packages/protocol");
class RemoteSettingsWindow {
  constructor({ BrowserWindow, ipcMain, remote }) {
    this.BrowserWindow = BrowserWindow; this.ipcMain = ipcMain; this.remote = remote;
    this.url = pathToFileURL(path.join(__dirname, "renderer", "index.html")).href;
    ipcMain.handle("mobile-settings:action", async (event, input) => {
      if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== this.url) return { error: "forbidden" };
      if (!safeTree(input) || Buffer.byteLength(JSON.stringify(input)) > 16384 || !input || Array.isArray(input)) return { error: "invalid_request" };
      try {
        switch (input.action) {
          case "status": return this.remote.snapshot();
          case "rename": return await remote.rename(input.name, input.reset === true);
          case "configure": return await remote.connectDefault();
          case "enable": await remote.start(); return remote.snapshot();
          case "disable": await remote.stop(true); return remote.snapshot();
          case "control": return remote.setControl(input.enabled);
          case "pair": return await remote.beginPairing(input.scopes);
          case "cancel-pair": return await remote.cancelPairing();
          case "test-notification": return remote.testNotification();
          case "poll": return await remote.pollPairing();
          case "confirm": return await remote.confirmPairing(input.fingerprint);
          case "revoke": return await remote.revoke(input.bindingId);
          default: return { error: "invalid_request" };
        }
      } catch (error) {
        const allowed = ["secure_storage_unavailable", "credential_store_invalid", "remote_journal_invalid", "invalid_code", "invalid_relay_origin", "remove_existing_identity_first", "capacity_exceeded", "pairing_expired", "invalid_claim", "invalid_scopes", "service_unconfigured"];
        return { error: error.message === "invalid_device_name" ? error.message : allowed.includes(error.message) ? error.message : "operation_failed" };
      }
    });
    this.changed = () => { if (this.window && !this.window.isDestroyed()) this.window.webContents.send("mobile-settings:changed", remote.snapshot()); };
    remote.on("changed", this.changed);
  }
  show() {
    if (this.window) { this.window.show(); this.window.focus(); return; }
    this.window = new this.BrowserWindow({ title: "Vibe Halo · 手机伴侣", width: 660, height: 770, minWidth: 420, minHeight: 500, show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, "settings-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", event => event.preventDefault());
    this.window.webContents.on("will-attach-webview", event => event.preventDefault());
    this.window.on("closed", () => { this.window = null; });
    this.window.once("ready-to-show", () => this.window?.show());
    this.window.loadURL(this.url);
  }
  destroy() { this.remote.off("changed", this.changed); this.ipcMain.removeHandler("mobile-settings:action"); this.window?.destroy(); this.window = null; }
}
module.exports = { RemoteSettingsWindow };
