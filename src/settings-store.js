"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = Object.freeze({
  approvalEnabled: true,
  inputReminderEnabled: true,
  integrationInstalled: true,
  openAtLogin: true,
  initialized: false,
  language: "system",
});

const LANGUAGE_VALUES = Object.freeze(["system", "en-US", "zh-CN"]);

function cleanIntegrationState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [agentId, state] of Object.entries(value).slice(0, 64)) {
    if (!/^[a-z0-9-]{1,80}$/.test(agentId) || !state || typeof state !== "object" || Array.isArray(state)) continue;
    output[agentId] = {
      disabledByUser: state.disabledByUser === true,
      detected: state.detected === true,
      installed: state.installed === true,
      healthy: state.healthy === true,
      verification: ["live", "contract", "none"].includes(state.verification) ? state.verification : "none",
      reason: typeof state.reason === "string" ? state.reason.slice(0, 240) : "",
      checkedAt: Number.isFinite(state.checkedAt) ? state.checkedAt : 0,
    };
  }
  return output;
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = { ...DEFAULTS };
    this.integrationStates = {};
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof DEFAULTS[key] === "boolean" && typeof raw[key] === "boolean") this.value[key] = raw[key];
        else if (key === "language" && LANGUAGE_VALUES.includes(raw[key])) this.value[key] = raw[key];
      }
      this.integrationStates = cleanIntegrationState(raw.integrations);
      if (!this.integrationStates.codex && raw.integrationInstalled === false) {
        this.integrationStates.codex = {
          disabledByUser: true, detected: true, installed: false, healthy: false,
          verification: "none", reason: "migrated-user-disabled", checkedAt: Date.now(),
        };
      }
    } catch {}
    return this.snapshot();
  }

  get(key) {
    return this.value[key];
  }

  set(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return false;
    if (typeof DEFAULTS[key] === "boolean" && typeof value !== "boolean") return false;
    if (key === "language" && !LANGUAGE_VALUES.includes(value)) return false;
    this.value[key] = value;
    this.save();
    return true;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...this.value, integrations: this.integrationStates }, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
  }

  snapshot() {
    return { ...this.value, integrations: this.integrations() };
  }

  integrations() {
    return JSON.parse(JSON.stringify(this.integrationStates));
  }

  getIntegration(agentId) {
    return this.integrations()[agentId] || {
      disabledByUser: false, detected: false, installed: false, healthy: false,
      verification: "none", reason: "not-scanned", checkedAt: 0,
    };
  }

  setIntegration(agentId, patch) {
    if (!/^[a-z0-9-]{1,80}$/.test(agentId) || !patch || typeof patch !== "object") return false;
    const current = this.getIntegration(agentId);
    this.integrationStates[agentId] = cleanIntegrationState({ [agentId]: { ...current, ...patch } })[agentId];
    this.save();
    return true;
  }
}

module.exports = { DEFAULTS, LANGUAGE_VALUES, SettingsStore, cleanIntegrationState };
