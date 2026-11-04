"use strict";

const { CLIENT_PREFERENCE_DEFAULTS } = require("./settings-store");
const { LANGUAGE_PREFERENCES, translateReason } = require("./i18n");

const GENERAL_BOOLEAN_KEYS = Object.freeze(["approvalEnabled", "inputReminderEnabled", "historyEnabled", "openAtLogin"]);
const CLIENT_PREFERENCE_KEYS = Object.freeze(Object.keys(CLIENT_PREFERENCE_DEFAULTS));
const SIMPLE_ACTIONS = Object.freeze([
  "rescan", "repair-all", "uninstall-all", "open-history", "open-mobile", "open-logs",
  "copy-diagnostics", "check-updates", "install-update", "codex-enable-feature", "codex-copy-review",
]);
const CLIENT_ACTIONS = Object.freeze(["client-enabled", "client-preference", "client-repair", "client-open-config"]);
const MAX_CONFIG_PATHS = 6;
const AGENT_ID = /^[a-z0-9-]{1,80}$/;

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Validates a renderer action and returns a normalized copy, or null. */
function validateSettingsAction(input, knownAgent = () => true) {
  if (!plainObject(input) || typeof input.type !== "string") return null;
  let size = 0;
  try { size = JSON.stringify(input).length; } catch { return null; }
  if (size > 1024) return null;
  const { type } = input;
  if (SIMPLE_ACTIONS.includes(type)) return { type };
  if (type === "general") {
    if (GENERAL_BOOLEAN_KEYS.includes(input.key) && typeof input.value === "boolean") return { type, key: input.key, value: input.value };
    if (input.key === "language" && LANGUAGE_PREFERENCES.includes(input.value)) return { type, key: input.key, value: input.value };
    return null;
  }
  if (!CLIENT_ACTIONS.includes(type)) return null;
  if (typeof input.agentId !== "string" || !AGENT_ID.test(input.agentId) || !knownAgent(input.agentId)) return null;
  if (type === "client-enabled") {
    return typeof input.value === "boolean" ? { type, agentId: input.agentId, value: input.value } : null;
  }
  if (type === "client-preference") {
    return CLIENT_PREFERENCE_KEYS.includes(input.key) && typeof input.value === "boolean"
      ? { type, agentId: input.agentId, key: input.key, value: input.value }
      : null;
  }
  return { type, agentId: input.agentId };
}

function supportedFeatures(descriptor) {
  return {
    approvals: descriptor.capabilities.approval === true,
    questions: descriptor.capabilities.elicitation === true,
    reminders: descriptor.capabilities.passiveApproval === true || descriptor.id === "codex",
    completions: descriptor.capabilities.completion !== false,
  };
}

function statusKey({ available, enabled, status }) {
  if (!available) return "unavailable";
  if (!enabled) return "off";
  if (status.disabled) return "clientDisabled";
  if (status.healthy) return "healthy";
  if (!status.detected) return "notDetected";
  return "repair";
}

function verificationKey(state, descriptor) {
  if (state.verification === "live" || descriptor.liveVerification === "local") return "live";
  if (state.verification === "contract" || descriptor.liveVerification === "contract-only") return "contract";
  return "none";
}

class SettingsService {
  constructor(options) {
    this.settings = options.settings;
    this.integrationManager = options.integrationManager;
    this.listAgents = options.listAgents;
    this.agent = options.agent;
    this.localization = options.localization;
    this.platform = options.platform || process.platform;
    this.version = options.version || "0.0.0";
    this.getUpdate = options.getUpdate || (() => ({ enabled: false, status: "disabled" }));
    this.getHistoryCount = options.getHistoryCount || (() => 0);
    this.getTheme = options.getTheme || (() => "light");
    this.effects = {
      setLogin: () => false,
      setLanguage: () => false,
      onGeneralChanged: () => {},
      onClientChanged: () => {},
      confirm: async () => false,
      copyText: () => {},
      showConfigPath: () => false,
      openHistory: () => {},
      openMobile: () => {},
      openLogs: () => {},
      diagnostics: () => "",
      checkUpdates: () => {},
      installUpdate: () => {},
      ...(options.effects || {}),
    };
  }

  t(key, params) {
    return this.localization.t(key, params);
  }

  codexStatus() {
    try {
      const hook = this.integrationManager.codexManager?.status?.();
      if (!hook) return null;
      return { feature: hook.feature, featureDisabled: hook.feature === "false", trustPending: (hook.trust?.pendingCount || 0) > 0 };
    } catch {
      return null;
    }
  }

  client(descriptor) {
    const state = this.settings.getIntegration(descriptor.id);
    let status;
    try { status = this.integrationManager.status(descriptor.id); }
    catch (error) { status = { detected: false, installed: false, healthy: false, disabled: false, reason: error.message }; }
    const available = descriptor.platforms?.[this.platform] === true;
    const enabled = state.enabled === true;
    const features = supportedFeatures(descriptor);
    const preferences = this.settings.getClientPreferences(descriptor.id);
    let configPaths = [];
    try { configPaths = (this.integrationManager.paths(descriptor.id) || []).slice(0, MAX_CONFIG_PATHS).map(String); } catch {}
    const reason = enabled ? (state.reason || status.reason || "") : "";
    return {
      id: descriptor.id,
      name: descriptor.name,
      tier: descriptor.tier,
      transport: descriptor.transport,
      appearance: descriptor.appearance || { glyph: "A", accent: "#64748B", inkLight: "#334155", inkDark: "#CBD5E1" },
      available,
      enabled,
      detected: status.detected === true,
      executable: status.executable === true,
      installed: status.installed === true,
      healthy: status.healthy === true,
      clientDisabled: status.disabled === true,
      status: statusKey({ available, enabled, status }),
      canToggle: available && (enabled || status.detected === true),
      verification: verificationKey(state, descriptor),
      reason: reason && reason !== "healthy" && reason !== "disabled-by-user" ? translateReason(this.localization, reason) : "",
      features,
      preferences: Object.fromEntries(CLIENT_PREFERENCE_KEYS.map(key => [key, preferences[key] === true])),
      configPaths,
      codex: descriptor.id === "codex" ? this.codexStatus() : null,
    };
  }

  state() {
    const clients = this.listAgents().map(descriptor => this.client(descriptor));
    const update = this.getUpdate() || { enabled: false, status: "disabled" };
    return {
      locale: this.localization.locale,
      theme: this.getTheme(),
      platform: this.platform,
      strings: this.localization.settingsStrings(),
      general: {
        approvalEnabled: this.settings.get("approvalEnabled") === true,
        inputReminderEnabled: this.settings.get("inputReminderEnabled") === true,
        historyEnabled: this.settings.get("historyEnabled") === true,
        openAtLogin: this.settings.get("openAtLogin") === true,
        language: this.settings.get("language"),
        version: this.version,
        historyCount: this.getHistoryCount(),
        update: {
          enabled: update.enabled === true,
          status: typeof update.status === "string" ? update.status : "disabled",
          availableVersion: typeof update.availableVersion === "string" ? update.availableVersion : "",
          percent: Number.isFinite(update.percent) ? Math.round(update.percent) : null,
        },
      },
      summary: {
        total: clients.filter(client => client.available).length,
        enabled: clients.filter(client => client.enabled).length,
        detected: clients.filter(client => client.detected).length,
      },
      clients,
    };
  }

  result(message, tone = "info", extra = {}) {
    return { ok: tone !== "error", message: message ? { tone, text: message } : null, state: this.state(), ...extra };
  }

  async perform(input) {
    const action = validateSettingsAction(input, id => !!this.agent(id));
    if (!action) return { ok: false, error: "invalid-action" };
    const descriptor = action.agentId ? this.agent(action.agentId) : null;
    const agentName = descriptor?.name || "";
    switch (action.type) {
      case "general": return this.setGeneral(action);
      case "client-enabled": return this.setClientEnabled(descriptor, action.value);
      case "client-preference": {
        if (!supportedFeatures(descriptor)[action.key]) return { ok: false, error: "unsupported-feature" };
        this.settings.setClientPreference(descriptor.id, action.key, action.value);
        this.effects.onClientChanged(descriptor.id, { key: action.key, value: action.value });
        return this.result("");
      }
      case "client-repair": {
        if (!this.settings.isClientEnabled(descriptor.id)) return { ok: false, error: "client-disabled" };
        let repaired;
        try { repaired = this.integrationManager.enable(descriptor.id); }
        catch (error) { repaired = { ok: false, reason: error.message }; }
        this.effects.onClientChanged(descriptor.id, { key: "enabled", value: true });
        return repaired?.ok
          ? this.result(this.t("settings.repaired", { agentName }), "success")
          : this.result(this.t("settings.enableFailed", { agentName, reason: translateReason(this.localization, repaired?.reason) }), "error");
      }
      case "client-open-config": {
        const shown = this.effects.showConfigPath(descriptor.id);
        return this.result(shown ? "" : this.t("settings.configMissing"), shown ? "info" : "error");
      }
      case "codex-enable-feature": {
        if (!await this.effects.confirm({
          message: this.t("dialog.enableCodexHooksQuestion"),
          confirm: this.t("dialog.enable"),
          type: "question",
        })) return this.result("");
        this.integrationManager.codexManager.enableFeature();
        const enabled = this.integrationManager.enable("codex");
        this.effects.onClientChanged("codex", { key: "enabled", value: true });
        return enabled?.ok
          ? this.result(this.t("settings.enabledMessage", { agentName: "Codex" }), "success")
          : this.result(this.t("settings.enableFailed", { agentName: "Codex", reason: translateReason(this.localization, enabled?.reason) }), "error");
      }
      case "codex-copy-review":
        this.effects.copyText("/hooks");
        return this.result(this.t("settings.copiedHooks"), "success");
      case "rescan":
        this.integrationManager.scan({ install: true });
        this.effects.onGeneralChanged("integrations");
        return this.result(this.t("settings.rescanned"), "success");
      case "repair-all":
        this.integrationManager.repairAll();
        this.effects.onGeneralChanged("integrations");
        return this.result(this.t("settings.repairedAll"), "success");
      case "uninstall-all": {
        if (!await this.effects.confirm({
          message: this.t("dialog.removeAllIntegrations"),
          detail: this.t("dialog.removeAllIntegrationsDetail"),
          confirm: this.t("dialog.uninstallAll"),
          type: "warning",
        })) return this.result("");
        this.integrationManager.uninstallAll();
        for (const item of this.listAgents()) {
          this.settings.setIntegration(item.id, { enabled: false, installed: false, healthy: false, reason: "disabled-by-user" });
          this.effects.onClientChanged(item.id, { key: "enabled", value: false });
        }
        return this.result(this.t("settings.removedAll"), "success");
      }
      case "open-history": this.effects.openHistory(); return this.result("");
      case "open-mobile": this.effects.openMobile(); return this.result("");
      case "open-logs": this.effects.openLogs(); return this.result("");
      case "copy-diagnostics":
        this.effects.copyText(this.effects.diagnostics());
        return this.result(this.t("settings.copiedDiagnostics"), "success");
      case "check-updates": this.effects.checkUpdates(); return this.result("");
      case "install-update": await this.effects.installUpdate(); return this.result("");
      default: return { ok: false, error: "invalid-action" };
    }
  }

  setGeneral(action) {
    if (action.key === "openAtLogin") {
      if (!this.effects.setLogin(action.value)) return this.result(this.t("settings.loginFailed"), "error");
    } else if (action.key === "language") {
      if (!this.effects.setLanguage(action.value)) return { ok: false, error: "invalid-action" };
    } else {
      this.settings.set(action.key, action.value);
    }
    this.effects.onGeneralChanged(action.key, action.value);
    return this.result("");
  }

  setClientEnabled(descriptor, value) {
    const agentName = descriptor.name;
    if (descriptor.platforms?.[this.platform] !== true) return { ok: false, error: "not-available-on-platform" };
    if (!value) {
      try { this.integrationManager.disable(descriptor.id); }
      catch (error) {
        this.settings.setIntegration(descriptor.id, { enabled: false, reason: "disabled-by-user" });
        this.effects.onClientChanged(descriptor.id, { key: "enabled", value: false });
        return this.result(this.t("settings.disableFailed", { agentName, reason: translateReason(this.localization, error.message) }), "error");
      }
      this.effects.onClientChanged(descriptor.id, { key: "enabled", value: false });
      return this.result(this.t("settings.disabledMessage", { agentName }), "info");
    }
    let installed;
    try { installed = this.integrationManager.enable(descriptor.id); }
    catch (error) { installed = { ok: false, reason: error.message }; }
    this.effects.onClientChanged(descriptor.id, { key: "enabled", value: true });
    return installed?.ok
      ? this.result(this.t("settings.enabledMessage", { agentName }), "success")
      : this.result(this.t("settings.enableFailed", { agentName, reason: translateReason(this.localization, installed?.reason) }), "error");
  }
}

module.exports = {
  CLIENT_PREFERENCE_KEYS,
  GENERAL_BOOLEAN_KEYS,
  SettingsService,
  statusKey,
  supportedFeatures,
  validateSettingsAction,
};
