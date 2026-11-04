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
  historyEnabled: true,
  historyPlaintextWarningSeen: false,
  historyStorageVersion: 1,
});

const LANGUAGE_VALUES = Object.freeze(["system", "en-US", "zh-CN"]);
const CLIENT_PREFERENCE_DEFAULTS = Object.freeze({
  approvals: true,
  questions: true,
  reminders: true,
  completions: true,
});
const AGENT_ID = /^[a-z0-9-]{1,80}$/;

function integrationEnabled(state) {
  if (typeof state.enabled === "boolean") return state.enabled;
  // Migration: integrations that were already installed and not switched off stay on;
  // every other client is off until the user enables it in Settings.
  return state.disabledByUser !== true && state.installed === true;
}

function cleanIntegrationState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [agentId, state] of Object.entries(value).slice(0, 64)) {
    if (!AGENT_ID.test(agentId) || !state || typeof state !== "object" || Array.isArray(state)) continue;
    const enabled = integrationEnabled(state);
    output[agentId] = {
      enabled,
      disabledByUser: !enabled,
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

function cleanClientPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [agentId, prefs] of Object.entries(value).slice(0, 64)) {
    if (!AGENT_ID.test(agentId) || !prefs || typeof prefs !== "object" || Array.isArray(prefs)) continue;
    const cleaned = {};
    for (const key of Object.keys(CLIENT_PREFERENCE_DEFAULTS)) {
      if (typeof prefs[key] === "boolean") cleaned[key] = prefs[key];
    }
    if (Object.keys(cleaned).length) output[agentId] = cleaned;
  }
  return output;
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = { ...DEFAULTS };
    this.integrationStates = {};
    this.clientPreferences = {};
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof DEFAULTS[key] === "boolean" && typeof raw[key] === "boolean") this.value[key] = raw[key];
        else if (key === "language" && LANGUAGE_VALUES.includes(raw[key])) this.value[key] = raw[key];
        else if (key === "historyStorageVersion" && Number.isInteger(raw[key]) && raw[key] >= 1) this.value[key] = raw[key];
      }
      this.integrationStates = cleanIntegrationState(raw.integrations);
      this.clientPreferences = cleanClientPreferences(raw.clients);
      if (!this.integrationStates.codex && raw.integrationInstalled === false) {
        this.integrationStates.codex = {
          enabled: false, disabledByUser: true, detected: true, installed: false, healthy: false,
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
    if (key === "historyStorageVersion" && (!Number.isInteger(value) || value < 1)) return false;
    this.value[key] = value;
    this.save();
    return true;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...this.value, integrations: this.integrationStates, clients: this.clientPreferences }, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
  }

  snapshot() {
    return { ...this.value, integrations: this.integrations(), clients: JSON.parse(JSON.stringify(this.clientPreferences)) };
  }

  integrations() {
    return JSON.parse(JSON.stringify(this.integrationStates));
  }

  getIntegration(agentId) {
    return this.integrations()[agentId] || {
      enabled: false, disabledByUser: true, detected: false, installed: false, healthy: false,
      verification: "none", reason: "not-scanned", checkedAt: 0,
    };
  }

  setIntegration(agentId, patch) {
    if (!AGENT_ID.test(agentId) || !patch || typeof patch !== "object") return false;
    const current = this.getIntegration(agentId);
    const next = { ...current, ...patch };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    else if (typeof patch.disabledByUser === "boolean") next.enabled = !patch.disabledByUser;
    else next.enabled = current.enabled;
    this.integrationStates[agentId] = cleanIntegrationState({ [agentId]: next })[agentId];
    this.save();
    return true;
  }

  isClientEnabled(agentId) {
    return this.getIntegration(agentId).enabled === true;
  }

  getClientPreferences(agentId) {
    return { ...CLIENT_PREFERENCE_DEFAULTS, ...(this.clientPreferences[agentId] || {}) };
  }

  setClientPreference(agentId, key, value) {
    if (!AGENT_ID.test(agentId) || !Object.prototype.hasOwnProperty.call(CLIENT_PREFERENCE_DEFAULTS, key) || typeof value !== "boolean") return false;
    this.clientPreferences[agentId] = { ...(this.clientPreferences[agentId] || {}), [key]: value };
    this.save();
    return true;
  }
}

module.exports = {
  CLIENT_PREFERENCE_DEFAULTS,
  DEFAULTS,
  LANGUAGE_VALUES,
  SettingsStore,
  cleanClientPreferences,
  cleanIntegrationState,
};
