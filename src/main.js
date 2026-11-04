"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { createPlatformAdapter, linuxOzoneRelaunchArgs } = require("./platform-adapter");

if (process.platform === "linux") {
  const relaunchArgs = linuxOzoneRelaunchArgs(process.argv, process.env);
  if (relaunchArgs) {
    const result = childProcess.spawnSync(process.execPath, relaunchArgs, {
      env: { ...process.env, VIBE_HALO_OZONE_BOOTSTRAPPED: "1" },
      stdio: "inherit",
    });
    process.exit(Number.isInteger(result.status) ? result.status : 1);
  }
}

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  screen,
  shell,
  Tray,
} = require("electron");
const { APP_ID, APP_NAME } = require("./constants");
const { agent, listAgents } = require("./agent-registry");
const { ApprovalStore } = require("./approval-store");
const { DecisionService } = require("./decision-service");
const { RemoteService } = require("./remote/remote-service");
const { performCompanionAction } = require("./remote/companion-actions");
const { CodexInputMonitor } = require("./codex-input-monitor");
const { completionFromStop } = require("./completion-event");
const { CompletionStore } = require("./completion-store");
const { HookManager } = require("./hook-manager");
const { approvalHistoryRecord, inputHistoryRecord, planHistoryRecord } = require("./history-events");
const { HistoryStore } = require("./history-store");
const { createLocalizer, translateReason } = require("./i18n");
const { IntegrationManager } = require("./integration-manager");
const { IslandController } = require("./island-controller");
const { InputRequestStore } = require("./input-request-store");
const { createLogger } = require("./logger");
const { SessionOriginStore } = require("./session-origin-store");
const { IslandServer } = require("./server");
const { SettingsStore } = require("./settings-store");
const { SettingsService } = require("./settings-service");
const { SettingsWindowController } = require("./settings-window-controller");
const { ShutdownCoordinator } = require("./shutdown-coordinator");
const { createTrayImage } = require("./tray-icon");
const { UpdateManager } = require("./update-manager");
const { autoUpdater } = require("electron-updater");
const appMetadata = require("../package.json");

app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
if (process.env.VIBE_HALO_USER_DATA) app.setPath("userData", process.env.VIBE_HALO_USER_DATA);
const platformAdapter = createPlatformAdapter({
  platform: process.platform,
  arch: process.arch,
  executablePath: process.execPath,
  packaged: app.isPackaged,
  runtimeRoot: process.env.VIBE_HALO_RUNTIME_DIR,
});
platformAdapter.configureEarly(app);

function hookScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "hooks", "vibe-halo-hook.js")
    : path.join(__dirname, "..", "hooks", "vibe-halo-hook.js");
}

function integrationAssetPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "hooks", "integrations")
    : path.join(__dirname, "..", "hooks", "integrations");
}

function createIntegrationManager(logger, settings) {
  const hookRuntime = platformAdapter.prepareHookRuntime(hookScriptPath());
  const codexManager = new HookManager({
    executablePath: process.execPath,
    hookScriptPath: hookRuntime.hookScriptPath,
    logger,
    platform: platformAdapter.platform,
    platformAdapter,
  });
  return new IntegrationManager({
    assetRoot: integrationAssetPath(),
    backupRoot: path.join(app.getPath("userData"), "integration-backups"),
    codexManager,
    executablePath: process.execPath,
    hookScriptPath: hookRuntime.hookScriptPath,
    logger,
    platform: platformAdapter.platform,
    platformAdapter,
    settings,
  });
}

if (process.argv.includes("--uninstall-hooks")) {
  try { createIntegrationManager({ info() {}, warn() {}, error() {} }, null).uninstallAll(); }
  catch {}
  app.exit(0);
} else {
  startApplication();
}

function startApplication() {
  const gotLock = process.env.VIBE_HALO_TEST === "1" || app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  let tray = null;
  let island = null;
  let history = null;
  let server = null;
  let inputMonitor = null;
  let hookManager = null;
  let integrationManager = null;
  let settings = null;
  let logger = null;
  let updateManager = null;
  let shutdownCoordinator = null;
  let remote = null;
  let settingsWindow = null;
  let localization = createLocalizer({ preference: "system", systemLocale: "en-US" });
  const t = (key, params) => localization.t(key, params);
  const approvals = new ApprovalStore();
  const decisions = new DecisionService({ approvalStore: approvals });
  const completions = new CompletionStore();
  const inputRequests = new InputRequestStore();
  const sessionOrigins = new SessionOriginStore();

  function shutdownServices(reason = "quit") {
    if (!shutdownCoordinator) {
      shutdownCoordinator = new ShutdownCoordinator({
        logger: logger || { warn() {} },
        steps: [
          { name: "remote-decisions", run: () => decisions.quiesceRemote() },
          {
            name: "server",
            run: async () => {
              const activeServer = server;
              server = null;
              if (activeServer) await activeServer.stop();
              else approvals.shutdown();
            },
          },
          { name: "remote-companion", run: async () => { await remote?.stop(); } },
          { name: "updater", run: () => updateManager?.stop() },
          {
            name: "input-monitor",
            run: () => {
              inputMonitor?.stop();
              inputMonitor = null;
            },
          },
          {
            name: "notifications",
            run: () => {
              inputRequests.clear("shutdown");
              completions.clear("shutdown");
            },
          },
          {
            name: "settings-window",
            run: () => {
              settingsWindow?.destroy();
              settingsWindow = null;
            },
          },
          {
            name: "history-store",
            run: () => {
              history?.stop();
              history = null;
            },
          },
          {
            name: "island",
            run: () => {
              island?.destroy();
              island = null;
            },
          },
          {
            name: "tray",
            run: () => {
              tray?.destroy();
              tray = null;
            },
          },
        ],
      });
    }
    return shutdownCoordinator.run(reason);
  }

  function requestQuit() {
    shutdownServices("quit").finally(() => app.quit());
  }

  async function installDownloadedUpdate() {
    if (!updateManager || updateManager.snapshot().status !== "downloaded") return;
    if (approvals.size > 0 || inputRequests.size > 0) {
      const result = await dialog.showMessageBox({
        type: "warning",
        buttons: [t("dialog.later"), t("dialog.returnAndUpdate")],
        defaultId: 0,
        cancelId: 0,
        title: APP_NAME,
        message: t("dialog.pendingRequests"),
        detail: t("dialog.pendingRequestsDetail"),
      });
      if (result.response !== 1) return;
    }
    const installed = await updateManager.install();
    if (!installed && shutdownCoordinator?.complete) {
      try { app.relaunch(); } catch {}
      app.exit(1);
    }
  }

  function setLogin(enabled) {
    try {
      if (process.env.VIBE_HALO_TEST !== "1") {
        platformAdapter.setLoginItem(app, !!enabled);
      }
      settings.set("openAtLogin", !!enabled);
      return true;
    } catch (error) {
      logger.warn("Failed to update login item", { message: error.message });
      return false;
    }
  }

  function diagnosticText() {
    const hook = hookManager.status();
    const local = server ? server.status() : { listening: false, port: null, runtimePath: "-" };
    const input = inputMonitor ? inputMonitor.status() : {
      running: false,
      sessionsFound: false,
      sessionsDir: "-",
      trackedFiles: 0,
      pendingCount: 0,
      lastError: null,
    };
    const integrations = listAgents().map(descriptor => {
      const state = settings.getIntegration(descriptor.id);
      const status = integrationManager.status(descriptor.id);
      const verification = state.verification === "live"
        ? t("diagnostics.liveVerified")
        : (state.verification === "contract" ? t("diagnostics.contractOnly") : t("diagnostics.unverified"));
      const integrationStatus = state.disabledByUser
        ? t("diagnostics.userDisabled")
        : (status.disabled
          ? t("diagnostics.clientHooksDisabled")
          : (status.healthy
            ? t("diagnostics.healthy")
            : (status.detected ? t("diagnostics.needsRepair") : t("diagnostics.notDetected"))));
      return t("diagnostics.integrationLine", { agentName: descriptor.name, status: integrationStatus, verification });
    });
    const update = updateManager?.snapshot() || {
      enabled: false,
      status: "disabled",
      availableVersion: "",
      percent: null,
      error: "",
    };
    const updateStatusKeys = {
      idle: "diagnostics.updateIdle",
      checking: "diagnostics.updateChecking",
      available: "diagnostics.updateAvailable",
      downloading: "diagnostics.updateDownloading",
      downloaded: "diagnostics.updateDownloaded",
      installing: "diagnostics.updateInstalling",
      error: "diagnostics.updateError",
    };
    const updateValues = [
      update.enabled ? t(updateStatusKeys[update.status] || "diagnostics.updateIdle") : t("diagnostics.buildDisabled"),
      update.availableVersion ? t("diagnostics.versionValue", { version: update.availableVersion }) : "",
      update.percent != null ? t("diagnostics.progressValue", { percent: update.percent }) : "",
      update.error ? t("diagnostics.errorValue", { error: update.error }) : "",
    ].filter(Boolean).join(", ");
    const platform = platformAdapter.status();
    const historyStatus = history?.snapshot() || {
      count: 0, mode: "memory", filePath: "-", lastError: "", retentionDays: 30, maxEntries: 200,
    };
    return [
      t("diagnostics.application", { appName: APP_NAME, version: app.getVersion() }),
      t("diagnostics.platform", { platform: platform.platform, arch: platform.arch, packageKind: platform.packageKind }),
      t("diagnostics.windowBackend", { value: platform.windowBackend }),
      ...(platform.degradedReason ? [t("diagnostics.platformDegraded", { reason: translateReason(localization, platform.degradedReason) })] : []),
      t("diagnostics.autoUpdate", { value: updateValues }),
      t("diagnostics.localService", { value: local.listening ? `127.0.0.1:${local.port}` : t("diagnostics.notRunning") }),
      t("diagnostics.approvals", { value: settings.get("approvalEnabled") ? t("diagnostics.enabled") : t("diagnostics.disabled") }),
      t("diagnostics.inputReminders", { value: settings.get("inputReminderEnabled") ? t("diagnostics.enabled") : t("diagnostics.disabled") }),
      t("diagnostics.history", {
        count: historyStatus.count,
        enabled: settings.get("historyEnabled") ? t("diagnostics.enabled") : t("diagnostics.disabled"),
        mode: t(`history.storage${historyStatus.mode[0]?.toUpperCase()}${historyStatus.mode.slice(1)}`),
        error: historyStatus.lastError || t("diagnostics.none"),
      }),
      t("diagnostics.historyFile", { path: historyStatus.filePath || "-" }),
      t("diagnostics.language", {
        locale: localization.locale,
        preference: localization.preference === "system"
          ? t("tray.followSystem")
          : (localization.preference === "zh-CN" ? "简体中文" : "English"),
      }),
      t("diagnostics.clientIntegrations"),
      ...integrations.map(value => `  ${value}`),
      t("diagnostics.pendingApprovals", { count: approvals.size }),
      t("diagnostics.pendingInput", { count: inputRequests.size }),
      t("diagnostics.codexDirectory", { value: hook.codexHomeExists ? t("diagnostics.found") : t("diagnostics.notFound") }),
      t("diagnostics.hooksFeature", { value: hook.feature }),
      t("diagnostics.hookEvents", { value: Object.entries(hook.events).map(([key, value]) => `${key}=${value ? "ok" : "missing"}`).join(", ") }),
      t("diagnostics.hookTrust", { value: Object.entries(hook.trust.events).map(([key, value]) => `${key}=${value}`).join(", ") }),
      t("diagnostics.runtime", { path: local.runtimePath }),
      t("diagnostics.sessionMonitor", {
        state: input.running ? t("diagnostics.running") : t("diagnostics.notRunning"),
        directory: input.sessionsFound ? t("diagnostics.found") : t("diagnostics.notFound"),
        files: input.trackedFiles,
        pending: input.pendingCount,
      }),
      t("diagnostics.sessionMonitorMode", { mode: input.lastCollaborationMode || "unknown" }),
      t("diagnostics.sessionDirectory", { path: input.sessionsDir }),
      t("diagnostics.sessionMonitorError", { error: input.lastError || t("diagnostics.none") }),
      t("diagnostics.logs", { path: logger.filePath }),
    ].join("\n");
  }

  function trayImage() {
    const iconDir = path.join(__dirname, "..", "assets", "icons");
    return platformAdapter.configureTrayImage(createTrayImage(nativeImage, path.join(iconDir, "32x32.png")));
  }

  function showSystemNotification(title, body) {
    return platformAdapter.showNotification({ tray, Notification, title, body });
  }

  function setLanguage(preference) {
    if (!settings?.set("language", preference)) return false;
    localization.setPreference(preference);
    if (island) island.refresh("language");
    else rebuildTray();
    settingsWindow?.refresh();
    return true;
  }

  function openSettings(page = "general") {
    return settingsWindow?.open(page) || false;
  }

  function clientAllows(agentId, feature) {
    if (!settings?.isClientEnabled(agentId)) return false;
    return feature ? settings.getClientPreferences(agentId)[feature] === true : true;
  }

  function onClientSettingChanged(agentId, change = {}) {
    const descriptor = agent(agentId);
    if (!descriptor) return;
    const enabled = settings.isClientEnabled(descriptor.id);
    if (!enabled || (change.key === "reminders" && change.value === false)) {
      inputRequests.clearAgent(descriptor.id, "disabled");
    }
    if (!enabled || (change.key === "completions" && change.value === false)) {
      completions.clear("disabled", null, descriptor.id);
    }
    if (descriptor.id === "codex" && enabled && change.key === "reminders" && change.value === true
      && settings.get("inputReminderEnabled")) inputMonitor?.replayPending();
    rebuildTray();
  }

  function onGeneralSettingChanged(key, value) {
    if (key === "inputReminderEnabled") {
      if (value) inputMonitor?.replayPending();
      else inputRequests.clear("disabled");
    }
    rebuildTray();
  }

  async function confirmFromSettings({ message, detail, confirm, type }) {
    const options = {
      type: type || "question",
      buttons: [t("dialog.cancel"), confirm || t("dialog.enable")],
      defaultId: type === "warning" ? 0 : 1,
      cancelId: 0,
      title: APP_NAME,
      message,
      ...(detail ? { detail } : {}),
    };
    const parent = settingsWindow?.window && !settingsWindow.window.isDestroyed() ? settingsWindow.window : null;
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  }

  function openHistory() {
    return openSettings("history");
  }

  function rebuildTray() {
    if (!tray) return;
    const hook = hookManager.status();
    const local = server ? server.status() : { listening: false, port: null };
    const descriptors = listAgents();
    const enabledCount = descriptors.filter(descriptor => settings.isClientEnabled(descriptor.id)).length;
    const codexEnabled = settings.isClientEnabled("codex");
    const statusLabel = !local.listening
      ? t("tray.serviceNotRunning")
      : codexEnabled && hook.feature === "false"
        ? t("tray.codexHooksDisabled")
        : codexEnabled && hook.trust.pendingCount > 0
          ? t("tray.codexHookPending")
          : enabledCount === 0
            ? t("tray.noClientsEnabled")
            : t("tray.integrationsEnabled", { enabled: enabledCount });
    const update = updateManager?.snapshot() || { enabled: false, status: "disabled" };
    const updateItems = [{ label: t("tray.version", { version: app.getVersion() }), enabled: false }];
    if (update.enabled) {
      if (update.status === "checking") {
        updateItems.push({ label: t("tray.checkingUpdates"), enabled: false });
      } else if (update.status === "available") {
        updateItems.push({ label: t("tray.preparingDownload", { version: update.availableVersion || t("fallback.newVersion") }), enabled: false });
      } else if (update.status === "downloading") {
        updateItems.push({ label: t("tray.downloading", { version: update.availableVersion || t("fallback.newVersion"), percent: update.percent ?? 0 }), enabled: false });
      } else if (update.status === "downloaded") {
        updateItems.push({
          label: t("tray.restartAndUpdate", { version: update.availableVersion || t("fallback.newVersion") }),
          click: () => installDownloadedUpdate(),
        });
      } else if (update.status === "installing") {
        updateItems.push({ label: t("tray.restartingAndUpdating"), enabled: false });
      } else {
        updateItems.push({
          label: update.status === "error" ? t("tray.checkAgain") : t("tray.checkUpdates"),
          click: () => updateManager.check({ manual: true }),
        });
      }
    }
    const items = [
      { label: statusLabel, enabled: enabledCount === 0, click: () => openSettings("general") },
      { type: "separator" },
      { label: t("tray.settings"), click: () => openSettings("general") },
      { label: t("tray.recentEvents", { count: history?.snapshot().count || 0 }), click: () => openHistory() },
      { label: t("tray.mobileCompanion"), click: () => openSettings("mobile") },
    ];
    if (codexEnabled && (hook.feature === "false" || hook.trust.pendingCount > 0)) {
      items.push({
        label: hook.feature === "false" ? t("tray.enableCodexHooks") : t("tray.reviewCodexHook"),
        click: () => openSettings("codex"),
      });
    }
    items.push(
      { type: "separator" },
      {
        label: t("tray.enableApprovals"),
        type: "checkbox",
        checked: settings.get("approvalEnabled"),
        click: item => { settings.set("approvalEnabled", item.checked); onGeneralSettingChanged("approvalEnabled", item.checked); },
      },
      {
        label: t("tray.inputReminders"),
        type: "checkbox",
        checked: settings.get("inputReminderEnabled"),
        click: item => { settings.set("inputReminderEnabled", item.checked); onGeneralSettingChanged("inputReminderEnabled", item.checked); },
      },
      { type: "separator" },
      ...updateItems,
      { type: "separator" },
      { label: t("tray.quit"), click: () => requestQuit() },
    );
    tray.setContextMenu(Menu.buildFromTemplate(items));
    tray.setToolTip(`${APP_NAME} — ${statusLabel}`);
    settingsWindow?.refresh();
  }

  function rememberAgentOrigin(data) {
    const descriptor = agent(data?.agentId || data?.agent_id);
    if (!descriptor) return false;
    const sessionId = typeof data.sessionId === "string" ? data.sessionId
      : (typeof data.session_id === "string" ? data.session_id : "");
    return sessionOrigins.remember({
      agentId: descriptor.id,
      sessionId,
      sourcePid: data.sourcePid ?? data.source_pid,
      pidChain: data.pidChain ?? data.pid_chain,
      cwd: data.cwd,
    });
  }

  function handleAgentEvent(data) {
    if (data.codex_session_role === "subagent") return;
    const descriptor = agent(data.agentId || data.agent_id) || agent("codex");
    const agentId = descriptor.id;
    const agentName = descriptor.name;
    const sessionId = typeof data.sessionId === "string" ? data.sessionId
      : (typeof data.session_id === "string" ? data.session_id : `${agentId}:unknown`);
    // Clients are opt-in: events from a client that is off are ignored (the hook already got its fail-open reply).
    if (!clientAllows(agentId)) return;
    rememberAgentOrigin({ ...data, agentId, sessionId });
    // Async Codex questions can remain unanswered across prompts and turn completion.
    // Read replies before taking the preservation snapshot (the hook may win the poll).
    const preserveInputKeys = new Set();
    if (agentId === "codex" && ["UserPromptSubmit", "Stop"].includes(data.event) && inputMonitor) {
      inputMonitor.scanNow(true);
      for (const key of inputMonitor.pendingAsyncRequestKeys(sessionId)) preserveInputKeys.add(key);
    }
    if (data.event === "UserPromptSubmit") {
      remote?.resolveSessionReminders(agentId, sessionId, preserveInputKeys);
      completions.clear("new-prompt", sessionId, agentId);
      inputRequests.clearSession(sessionId, "new-prompt", agentId, preserveInputKeys);
      return;
    }
    if (data.event === "PermissionRequest" && descriptor.capabilities.passiveApproval) {
      if (!clientAllows(agentId, "reminders")) return;
      remote?.recordReminder({ agentId, sessionId, requestKey: `${agentId}:${sessionId}:permission:${data.requestId || data.request_id || data.toolUseId || "pending"}` }, "input");
      if (!settings.get("inputReminderEnabled")) return;
      const requestId = typeof data.requestId === "string" ? data.requestId : (typeof data.request_id === "string" ? data.request_id : data.toolUseId || Date.now());
      inputRequests.enqueue({
        agentId, agentName, requestKey: `${agentId}:${sessionId}:permission:${requestId}`, sessionId,
        titleKey: "fallback.passiveApprovalTitle",
        titleParams: { agentName },
        contentKey: "fallback.passiveApprovalContent",
        contentParams: { agentName, toolName: data.toolName || data.tool_name || t("fallback.tool") },
        cwd: data.cwd, sourcePid: data.sourcePid, pidChain: data.pidChain,
      });
      return;
    }
    if (data.event !== "Stop") return;
    const remoteCompletion = completionFromStop(data, descriptor, sessionId);
    if (!remoteCompletion) return;
    remote?.resolveSessionReminders(agentId, sessionId, preserveInputKeys);
    inputRequests.clearSession(sessionId, "session-stopped", agentId, preserveInputKeys);
    if (!clientAllows(agentId, "completions")) return;
    remote?.recordReminder(remoteCompletion, remoteCompletion.completionKind === "plan" ? "plan" : "completion");
    if (approvals.size > 0 || inputRequests.size > 0) return;
    completions.show(remoteCompletion);
  }

  app.on("second-instance", () => {
    // Launching Vibe Halo again brings the settings window to the foreground.
    if (!openSettings("general")) showSystemNotification(APP_NAME, t("notification.background"));
  });

  app.on("window-all-closed", event => event?.preventDefault?.());

  app.whenReady().then(async () => {
    platformAdapter.configureReady(app);
    logger = createLogger(path.join(app.getPath("userData"), "logs"));
    settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
    remote = new RemoteService({ userData: app.getPath("userData"), safeStorage, approvals, decisions, logger,
      allowLocal: !app.isPackaged && process.env.VIBE_HALO_TEST === "1" });
    await remote.initialize({ autoConnect: process.env.VIBE_HALO_TEST !== "1" });
    localization = createLocalizer({ preference: settings.get("language"), systemLocale: app.getLocale() });
    remote.getLocale = () => localization.locale;
    integrationManager = createIntegrationManager(logger, settings);
    hookManager = integrationManager.codexManager;
    const firstRun = !settings.get("initialized");
    if (firstRun) {
      setLogin(true);
      settings.set("initialized", true);
    }

    const integrationResults = integrationManager.scan({ install: true });
    for (const result of integrationResults) {
      if (result.detected && result.enabled && !result.installResult?.ok) {
        logger.warn("Client integration not installed", { agentId: result.agent.id, reason: result.installResult?.reason || result.reason });
      }
    }

    history = new HistoryStore({
      filePath: path.join(app.getPath("userData"), "history.json"),
      safeStorage,
      platform: process.platform,
      logger,
    });
    history.load();
    remote.historyStore = history;
    remote.inputRequests = inputRequests;
    const appendHistory = record => {
      if (record && settings.get("historyEnabled")) {
        const saved = history.append(record);
        if (remote.enabled && saved?.kind === "plan") remote.media.capture(`history:${saved.id}`, saved.content, saved.cwd);
      }
    };
    approvals.on("finalized", event => appendHistory(approvalHistoryRecord(event)));
    inputRequests.on("finalized", event => appendHistory(inputHistoryRecord(event)));
    completions.on("shown", item => appendHistory(planHistoryRecord(item)));
    history.on("changed", () => rebuildTray());
    island = new IslandController({
      BrowserWindow,
      clipboard,
      completionStore: completions,
      inputRequestStore: inputRequests,
      ipcMain,
      logger,
      nativeTheme,
      approvalStore: approvals,
      decisionService: decisions,
      screen,
      localization,
      platformAdapter,
      onChanged: () => rebuildTray(),
    });
    island.create();

    inputMonitor = new CodexInputMonitor({
      logger,
      onRemoteRequested: request => {
        if (!clientAllows("codex", "reminders")) return;
        remote?.recordReminder({ ...request, agentId: "codex" }, "input");
      },
      onRequested: request => {
        if (!settings.get("inputReminderEnabled") || !clientAllows("codex", "reminders")) return false;
        const origin = sessionOrigins.get("codex", request.sessionId);
        return !!inputRequests.enqueue({
          ...request,
          agentId: "codex",
          agentName: "Codex",
          cwd: request.cwd || origin?.cwd || "",
          sourcePid: origin?.sourcePid ?? null,
          pidChain: origin?.pidChain || [],
        }).entry;
      },
      onResolved: request => {
        remote?.resolveReminder(request.requestKey, request.reason);
        return inputRequests.resolve(request.requestKey, { answers: request.answers, answerAvailable: request.answerAvailable }, request.reason);
      },
    });
    inputMonitor.start();

    server = new IslandServer({
      approvalStore: approvals,
      isApprovalEnabled: (agentId, kind) => settings.get("approvalEnabled")
        && clientAllows(agentId, kind === "elicitation" ? "questions" : "approvals"),
      logger,
      onPermission: rememberAgentOrigin,
      onEvent: handleAgentEvent,
    });
    await server.start();

    const updateEnabled = app.isPackaged
      && process.platform === "win32"
      && process.env.VIBE_HALO_TEST !== "1"
      && appMetadata.autoUpdateEnabled === true;
    updateManager = new UpdateManager({
      updater: autoUpdater,
      enabled: updateEnabled,
      currentVersion: app.getVersion(),
      logger,
      beforeInstall: () => shutdownServices("update"),
    });
    updateManager.on("changed", (snapshot, reason) => {
      rebuildTray();
      if (reason === "downloaded") showSystemNotification(
        t("notification.updateReadyTitle", { appName: APP_NAME }),
        t("notification.updateReadyContent", { version: snapshot.availableVersion || t("fallback.newVersion") })
      );
    });
    updateManager.on("manual-result", result => {
      if (result.kind === "up-to-date") {
        dialog.showMessageBox({ type: "info", title: APP_NAME, message: t("dialog.updateCurrent", { version: app.getVersion() }) });
      } else if (result.kind === "error") {
        dialog.showMessageBox({ type: "warning", title: APP_NAME, message: t("dialog.updateCheckFailed"), detail: t("dialog.updateCheckFailedDetail") });
      }
    });

    const settingsService = new SettingsService({
      settings,
      integrationManager,
      listAgents,
      agent,
      localization,
      platform: platformAdapter.platform,
      version: app.getVersion(),
      getUpdate: () => updateManager?.snapshot(),
      getHistoryCount: () => history?.snapshot().count || 0,
      getTheme: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
      history,
      companion: {
        snapshot: () => remote.snapshot(),
        perform: input => performCompanionAction(remote, input),
      },
      effects: {
        setLogin,
        setLanguage,
        onGeneralChanged: onGeneralSettingChanged,
        onClientChanged: onClientSettingChanged,
        confirm: confirmFromSettings,
        copyText: value => clipboard.writeText(String(value || "")),
        openLogs: () => shell.openPath(path.dirname(logger.filePath)),
        diagnostics: () => diagnosticText(),
        checkUpdates: () => updateManager?.check({ manual: true }),
        installUpdate: () => installDownloadedUpdate(),
      },
    });
    settingsWindow = new SettingsWindowController({
      BrowserWindow,
      ipcMain,
      nativeTheme,
      service: settingsService,
      platform: platformAdapter.platform,
      logger,
    });
    remote.on("changed", () => settingsWindow?.refresh());

    tray = new Tray(trayImage());
    tray.on("click", () => {
      if (approvals.current) island.expand(approvals.current.id);
      else if (inputRequests.current) island.expand(inputRequests.current.id);
      else if (completions.current) island.expand(completions.current.id);
      else if (process.platform !== "darwin") openSettings("general");
    });
    rebuildTray();
    updateManager.start();
    if (firstRun && process.env.VIBE_HALO_TEST !== "1") openSettings("general");
    logger.info("Application ready", { version: app.getVersion(), packaged: app.isPackaged, ...platformAdapter.status() });
    const demoApproval = process.env.VIBE_HALO_TEST === "1" && process.argv.includes("--demo-approval");
    const demoPlanReady = process.env.VIBE_HALO_TEST === "1" && process.argv.includes("--demo-plan-ready");
    const demoHistory = process.env.VIBE_HALO_TEST === "1" && process.argv.includes("--demo-history");
    const { createSmokeTasks, captureSmokeWindow } = require("./smoke-test");
    const smokeTasks = createSmokeTasks();
    const demoSettingsArg = process.argv.find(value => value === "--demo-settings" || value.startsWith("--demo-settings="));
    if (process.env.VIBE_HALO_TEST === "1" && demoSettingsArg) {
      const demoPage = demoSettingsArg.includes("=") ? demoSettingsArg.split("=")[1] : "general";
      openSettings(demoPage);
      if (process.env.VIBE_HALO_SETTINGS_SCREENSHOT) {
        smokeTasks.schedule(1500, async () => {
          try {
            await captureSmokeWindow(settingsWindow.window, process.env.VIBE_HALO_SETTINGS_SCREENSHOT, "Boolean(document.querySelector('.page .page-header'))");
          } catch (error) {
            logger.warn("Demo settings screenshot failed", { message: error.message });
            throw error;
          }
        });
      }
    }
    if (demoApproval || demoPlanReady) {
      let demo;
      if (demoApproval) {
        demo = approvals.enqueue({
          agentId: "codex",
          agentName: "Codex",
          kind: "approval",
          options: [
            { id: "allow", labelKey: "action.allowOnce", tone: "primary" },
            { id: "deny", labelKey: "action.deny", tone: "danger" },
            { id: "native", labelKey: "action.handleInClient", tone: "secondary", overflow: true },
          ],
          sessionId: "codex:demo",
          toolUseId: "demo-tool",
          toolName: "PowerShell",
          description: t("demo.description"),
          toolInput: {
            command: "npm test -- --test-reporter=spec --test-concurrency=1",
            cwd: "C:\\Projects\\demo-with-a-longer-workspace-name",
            timeout_ms: 120000,
            description: t("demo.description"),
            environment: { CI: "1", FORCE_COLOR: "0" },
          },
          cwd: "C:\\Projects\\demo",
          sourcePid: process.pid,
          pidChain: [process.pid],
        }, { complete() {} }).entry;
      } else {
        handleAgentEvent({
          event: "Stop",
          agent_id: "codex",
          session_id: "codex:demo-plan",
          permission_mode: "plan",
          assistant_last_output: t("demo.planReadyOutput"),
          cwd: "C:\\Projects\\demo",
          source_pid: process.pid,
          pid_chain: [process.pid],
        });
        demo = completions.current;
      }
      if (process.argv.includes("--demo-expanded")) {
        setTimeout(() => island.expand(demo.id), 180);
      }
      if (demoApproval && process.env.VIBE_HALO_SMOKE_ACTION_FILE) {
        const actionFile = process.env.VIBE_HALO_SMOKE_ACTION_FILE;
        const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
        const reportActionResult = () => {
          try {
            fs.mkdirSync(path.dirname(actionFile), { recursive: true });
            fs.writeFileSync(actionFile, approvals.size === 0 ? "resolved\n" : "pending\n");
          } catch {}
        };
        smokeTasks.schedule(250, async () => {
          try {
            let clicked = false;
            for (let attempt = 0; attempt < 20 && !clicked; attempt += 1) {
              clicked = await island.window.webContents.executeJavaScript(`(() => {
                const button = document.querySelector('#actions button.primary');
                if (!button) return false;
                button.click();
                return true;
              })()`, true);
              if (!clicked) await wait(100);
            }
            for (let attempt = 0; attempt < 20 && approvals.size > 0; attempt += 1) {
              await wait(50);
            }
            reportActionResult();
            if (approvals.size > 0) throw new Error("Demo approval remained pending");
          } catch (error) {
            logger.warn("Demo approval click failed", { message: error.message });
            reportActionResult();
            throw error;
          }
        });
      }
      if (process.env.VIBE_HALO_SCREENSHOT) {
        smokeTasks.schedule(1400, async () => {
          try {
            await captureSmokeWindow(island.window, process.env.VIBE_HALO_SCREENSHOT, "Boolean(document.querySelector('#compact-summary')?.textContent)");
          } catch (error) {
            logger.warn("Demo screenshot failed", { message: error.message });
            throw error;
          }
        });
      }
    }
    if (demoHistory) {
      const now = Date.now();
      history.append({
        kind: "approval",
        agentId: "zcode",
        agentName: "ZCode",
        sessionId: "zcode:history-demo",
        title: t("demo.description"),
        toolName: "Bash",
        description: t("demo.description"),
        cwd: "C:\\Projects\\demo",
        toolInput: {
          command: "npm test -- --test-reporter=spec",
          cwd: "C:\\Projects\\demo",
          timeout_ms: 120000,
          environment: { CI: "1", API_TOKEN: "redacted-demo" },
        },
        outcome: "allow",
        reason: "allow",
        createdAt: now - 240_000,
        finalizedAt: now - 230_000,
      });
      history.append({
        kind: "question",
        agentId: "codex",
        agentName: "Codex",
        sessionId: "codex:history-demo",
        titleKey: "fallback.codexWaitingChoice",
        questions: [{
          id: "approach",
          header: "Approach",
          question: "Which implementation should be used?",
          options: [{ id: "panel", label: "Right-side panel", description: "Keep the island independent." }],
        }],
        answers: { approach: ["Right-side panel"] },
        answerAvailable: true,
        outcome: "submit",
        reason: "answered",
        createdAt: now - 180_000,
        finalizedAt: now - 170_000,
      });
      history.append({
        kind: "plan",
        agentId: "codex",
        agentName: "Codex",
        sessionId: "codex:history-plan",
        titleKey: "fallback.planReadyTitle",
        content: t("demo.planReadyOutput"),
        outcome: "ready",
        reason: "shown",
        createdAt: now - 60_000,
        finalizedAt: now - 60_000,
      });
      openSettings("history");
      if (process.env.VIBE_HALO_HISTORY_SCREENSHOT) {
        smokeTasks.schedule(1200, async () => {
          try {
            await captureSmokeWindow(settingsWindow.window, process.env.VIBE_HALO_HISTORY_SCREENSHOT, "Boolean(document.querySelector('.event-card'))");
            if (process.env.VIBE_HALO_HISTORY_DETAIL_SCREENSHOT) {
              await settingsWindow.window.webContents.executeJavaScript(`document.querySelector('.event-card:last-child')?.click()`, true);
              await new Promise(resolve => setTimeout(resolve, 240));
              await captureSmokeWindow(settingsWindow.window, process.env.VIBE_HALO_HISTORY_DETAIL_SCREENSHOT, "Boolean(document.querySelector('#detail-view')) && Boolean(document.querySelector('#detail-sections')?.children.length)");
            }
          } catch (error) {
            logger.warn("Demo history screenshot failed", { message: error.message });
            throw error;
          }
        });
      }
    }
    if (process.argv.includes("--smoke-test")) {
      smokeTasks.schedule(1500, async () => {});
      smokeTasks.finish().then(() => shutdownServices("smoke-test").then(() => app.exit(0)), async error => {
        logger.warn("Smoke checks failed", { message: error.message });
        await shutdownServices("smoke-test-failed");
        app.exit(1);
      });
    }
  }).catch(error => {
    try { logger?.error("Startup failed", { message: error.message }); } catch {}
    dialog.showErrorBox(APP_NAME, t("dialog.startupFailed", { message: error.message }));
    requestQuit();
  });

  app.on("before-quit", event => {
    if (shutdownCoordinator?.complete) return;
    event.preventDefault();
    requestQuit();
  });
}
