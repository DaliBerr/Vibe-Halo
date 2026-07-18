"use strict";

const { EventEmitter } = require("events");

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const VALID_STATUSES = new Set([
  "disabled",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "up-to-date",
  "installing",
  "error",
]);

function cleanVersion(value) {
  return typeof value === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(value.trim())
    ? value.trim()
    : "";
}

function cleanPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function errorCode(error) {
  const value = typeof error?.code === "string" ? error.code : "update-failed";
  return /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : "update-failed";
}

class UpdateManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.updater = options.updater || null;
    this.enabled = options.enabled === true && !!this.updater;
    this.currentVersion = cleanVersion(options.currentVersion) || "0.0.0";
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.beforeInstall = options.beforeInstall || (async () => {});
    this.initialDelayMs = Number.isFinite(options.initialDelayMs)
      ? Math.max(0, options.initialDelayMs)
      : INITIAL_CHECK_DELAY_MS;
    this.checkIntervalMs = Number.isFinite(options.checkIntervalMs)
      ? Math.max(1_000, options.checkIntervalMs)
      : CHECK_INTERVAL_MS;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.started = false;
    this.manualPending = false;
    this.initialTimer = null;
    this.intervalTimer = null;
    this.handlers = new Map();
    this.state = {
      status: this.enabled ? "idle" : "disabled",
      currentVersion: this.currentVersion,
      availableVersion: "",
      percent: null,
      error: "",
    };
  }

  snapshot() {
    return { ...this.state, enabled: this.enabled };
  }

  transition(patch, reason) {
    const status = VALID_STATUSES.has(patch.status) ? patch.status : this.state.status;
    this.state = {
      ...this.state,
      ...patch,
      status,
      currentVersion: this.currentVersion,
    };
    this.emit("changed", this.snapshot(), reason);
  }

  bind(event, handler) {
    this.handlers.set(event, handler);
    this.updater.on(event, handler);
  }

  start() {
    if (!this.enabled || this.started) return this.snapshot();
    this.started = true;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    this.updater.fullChangelog = false;
    this.updater.logger = null;

    this.bind("checking-for-update", () => {
      this.transition({ status: "checking", percent: null, error: "" }, "checking");
    });
    this.bind("update-available", info => {
      const availableVersion = cleanVersion(info?.version);
      this.transition({ status: "available", availableVersion, percent: 0, error: "" }, "available");
      this.finishManual("available", availableVersion);
      this.logger.info("Update available", { version: availableVersion || "unknown" });
    });
    this.bind("update-not-available", () => {
      this.transition({ status: "up-to-date", availableVersion: "", percent: null, error: "" }, "up-to-date");
      this.finishManual("up-to-date");
      this.logger.info("Update check completed", { result: "up-to-date" });
    });
    this.bind("download-progress", progress => {
      this.transition({ status: "downloading", percent: cleanPercent(progress?.percent), error: "" }, "download-progress");
    });
    this.bind("update-downloaded", info => {
      const availableVersion = cleanVersion(info?.version) || this.state.availableVersion;
      this.transition({ status: "downloaded", availableVersion, percent: 100, error: "" }, "downloaded");
      this.finishManual("downloaded", availableVersion);
      this.logger.info("Update downloaded", { version: availableVersion || "unknown" });
    });
    this.bind("error", error => this.handleError(error, "updater-error"));

    this.initialTimer = this.setTimeout(() => this.check({ manual: false }), this.initialDelayMs);
    this.intervalTimer = this.setInterval(() => this.check({ manual: false }), this.checkIntervalMs);
    this.initialTimer?.unref?.();
    this.intervalTimer?.unref?.();
    return this.snapshot();
  }

  async check(options = {}) {
    if (!this.enabled || !this.started) return { ok: false, reason: "disabled" };
    if (["checking", "available", "downloading", "downloaded", "installing"].includes(this.state.status)) {
      return { ok: false, reason: "busy", status: this.state.status };
    }
    this.manualPending = options.manual === true;
    this.transition({ status: "checking", percent: null, error: "" }, "checking");
    try {
      await this.updater.checkForUpdates();
      return { ok: true, status: this.state.status };
    } catch (error) {
      this.handleError(error, "check-failed");
      return { ok: false, reason: "check-failed" };
    }
  }

  finishManual(kind, version = "") {
    if (!this.manualPending) return;
    this.manualPending = false;
    this.emit("manual-result", { kind, version: cleanVersion(version) });
  }

  handleError(error, reason) {
    const code = errorCode(error);
    if (this.state.status === "error" && this.state.error === code && !this.manualPending) return;
    this.transition({ status: "error", percent: null, error: code }, reason);
    this.finishManual("error");
    this.logger.warn("Update operation failed", { code });
  }

  async install() {
    if (!this.enabled || this.state.status !== "downloaded") return false;
    this.transition({ status: "installing", error: "" }, "installing");
    try {
      await this.beforeInstall();
      this.updater.quitAndInstall(true, true);
      return true;
    } catch (error) {
      this.handleError(error, "install-failed");
      this.emit("install-error");
      return false;
    }
  }

  stop() {
    if (this.initialTimer) this.clearTimeout(this.initialTimer);
    if (this.intervalTimer) this.clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    if (this.updater) {
      for (const [event, handler] of this.handlers) this.updater.removeListener(event, handler);
    }
    this.handlers.clear();
    this.started = false;
  }
}

module.exports = {
  CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  UpdateManager,
  cleanPercent,
  cleanVersion,
  errorCode,
};
