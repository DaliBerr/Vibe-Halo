"use strict";

const { CLIENT_PREFERENCE_DEFAULTS } = require("./settings-store");
const { LANGUAGE_PREFERENCES, translateReason } = require("./i18n");
const { copyValue, historyDetail, historyListState, validId, COPY_SECTIONS } = require("./history-presenter");
const { truncateUtf8 } = require("./history-store");

const GENERAL_BOOLEAN_KEYS = Object.freeze(["approvalEnabled", "inputReminderEnabled", "historyEnabled", "openAtLogin"]);
const CLIENT_PREFERENCE_KEYS = Object.freeze(Object.keys(CLIENT_PREFERENCE_DEFAULTS));
const SIMPLE_ACTIONS = Object.freeze([
  "rescan", "repair-all", "uninstall-all", "open-logs", "copy-diagnostics", "check-updates", "install-update",
  "codex-enable-feature", "codex-copy-review", "history-list", "history-clear",
]);
const CLIENT_ACTIONS = Object.freeze(["client-enabled", "client-visible", "client-preference", "client-repair"]);
const HISTORY_ID_ACTIONS = Object.freeze(["history-get", "history-delete", "history-copy"]);
const AGENT_ID = /^[a-z0-9-]{1,80}$/;
// Bundled brand icons (src/settings-renderer/icons, LobeHub Icons, MIT). Mono icons are tinted with the theme text color.
const CLIENT_ICONS = Object.freeze({
  codex: "color", zcode: "mono", "qwen-code": "color", "copilot-cli": "mono", "claude-code": "color",
  codebuddy: "color", hermes: "mono", opencode: "mono", "deepseek-harness": "color", "kimi-code": "color",
  qoder: "mono", qoderwork: "mono", "gemini-cli": "color", antigravity: "color", "cursor-agent": "mono",
  kiro: "color", openclaw: "color",
});

function clientIcon(agentId) {
  const mode = CLIENT_ICONS[agentId];
  return mode ? { src: `icons/${agentId}.svg`, mono: mode === "mono" } : null;
}

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
  if (HISTORY_ID_ACTIONS.includes(type)) {
    if (!validId(input.id)) return null;
    if (type === "history-copy") return COPY_SECTIONS.has(input.section) ? { type, id: input.id, section: input.section } : null;
    return { type, id: input.id };
  }
  if (type === "mobile") {
    return plainObject(input.request) && typeof input.request.action === "string" ? { type, request: input.request } : null;
  }
  if (type === "general") {
    if (GENERAL_BOOLEAN_KEYS.includes(input.key) && typeof input.value === "boolean") return { type, key: input.key, value: input.value };
    if (input.key === "language" && LANGUAGE_PREFERENCES.includes(input.value)) return { type, key: input.key, value: input.value };
    return null;
  }
  if (!CLIENT_ACTIONS.includes(type)) return null;
  if (typeof input.agentId !== "string" || !AGENT_ID.test(input.agentId) || !knownAgent(input.agentId)) return null;
  if (type === "client-enabled" || type === "client-visible") {
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
    this.history = options.history || null;
    this.companion = options.companion || null;
    this.effects = {
      setLogin: () => false,
      setLanguage: () => false,
      onGeneralChanged: () => {},
      onClientChanged: () => {},
      confirm: async () => false,
      copyText: () => {},
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
    const preferences = this.settings.getClientPreferences(descriptor.id);
    const reason = enabled ? (state.reason || status.reason || "") : "";
    const codex = descriptor.id === "codex" ? this.codexStatus() : null;
    let clientStatus = statusKey({ available, enabled, status });
    // Codex writes its hook first and then waits for the user's /hooks trust review.
    if (codex && enabled && status.installed && codex.trustPending && !codex.featureDisabled) clientStatus = "review";
    return {
      id: descriptor.id,
      name: descriptor.name,
      appearance: descriptor.appearance || { glyph: "A", accent: "#64748B", inkLight: "#334155", inkDark: "#CBD5E1" },
      icon: clientIcon(descriptor.id),
      available,
      enabled,
      visible: this.settings.isClientVisible(descriptor.id),
      detected: status.detected === true,
      healthy: status.healthy === true,
      status: clientStatus,
      canToggle: available && (enabled || status.detected === true),
      reason: reason && clientStatus !== "review" && !["healthy", "disabled-by-user", "missing"].includes(reason) ? translateReason(this.localization, reason) : "",
      features: supportedFeatures(descriptor),
      preferences: Object.fromEntries(CLIENT_PREFERENCE_KEYS.map(key => [key, preferences[key] === true])),
      codex,
    };
  }

  historyState() {
    if (!this.history) return null;
    return historyListState(this.history, this.localization, { shouldUseDarkColors: this.getTheme() === "dark" });
  }

  companionSnapshot() {
    try { return this.companion?.snapshot?.() || null; } catch { return null; }
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
        historyCount: this.history ? this.history.snapshot().count : this.getHistoryCount(),
        historyMode: this.history ? this.history.snapshot().mode : "memory",
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
      icons: Object.fromEntries(Object.keys(CLIENT_ICONS).map(id => [id, clientIcon(id)])),
      companion: this.companionSnapshot(),
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
      case "client-visible":
        this.settings.setClientVisible(descriptor.id, action.value);
        return this.result("");
      case "history-list":
        return { ok: true, history: this.historyState() };
      case "history-get": {
        const detail = this.history ? historyDetail(this.history, this.localization, action.id) : null;
        return detail ? { ok: true, detail } : { ok: false, error: "not-found" };
      }
      case "history-copy": {
        const detail = this.history ? historyDetail(this.history, this.localization, action.id) : null;
        const value = copyValue(detail, action.section);
        if (!value) return { ok: false, error: "not-found" };
        this.effects.copyText(truncateUtf8(value, 128 * 1024));
        return { ok: true, message: { tone: "success", text: this.t("history.copied") } };
      }
      case "history-delete": {
        if (!this.history?.get(action.id)) return { ok: false, error: "not-found" };
        if (!await this.effects.confirm({
          message: this.t("history.deleteConfirm"), detail: this.t("history.deleteDetail"),
          confirm: this.t("history.delete"), type: "warning",
        })) return { ok: false, error: "cancelled" };
        this.history.remove(action.id);
        return { ok: true, history: this.historyState() };
      }
      case "history-clear": {
        if (!this.history?.snapshot().count) return { ok: false, error: "empty" };
        if (!await this.effects.confirm({
          message: this.t("history.clearConfirm"), detail: this.t("history.clearDetail"),
          confirm: this.t("history.clear"), type: "warning",
        })) return { ok: false, error: "cancelled" };
        this.history.clear("user-cleared");
        return { ok: true, history: this.historyState() };
      }
      case "mobile": {
        if (!this.companion?.perform) return { ok: false, error: "unavailable" };
        const companion = await this.companion.perform(action.request);
        return companion?.error ? { ok: false, error: companion.error } : { ok: true, companion };
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
  CLIENT_ICONS,
  CLIENT_PREFERENCE_KEYS,
  GENERAL_BOOLEAN_KEYS,
  SettingsService,
  statusKey,
  supportedFeatures,
  validateSettingsAction,
};
