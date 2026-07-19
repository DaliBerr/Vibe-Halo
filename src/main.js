"use strict";

const fs = require("fs");
const path = require("path");
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
  screen,
  shell,
  Tray,
} = require("electron");
const { APP_ID, APP_NAME } = require("./constants");
const { agent, listAgents } = require("./agent-registry");
const { ApprovalStore } = require("./approval-store");
const { CodexInputMonitor } = require("./codex-input-monitor");
const { CompletionStore } = require("./completion-store");
const { HookManager } = require("./hook-manager");
const { createLocalizer, translateReason } = require("./i18n");
const { IntegrationManager } = require("./integration-manager");
const { IslandController } = require("./island-controller");
const { InputRequestStore } = require("./input-request-store");
const { createLogger } = require("./logger");
const { IslandServer } = require("./server");
const { SettingsStore } = require("./settings-store");
const { ShutdownCoordinator } = require("./shutdown-coordinator");
const { UpdateManager } = require("./update-manager");
const { createPlatformAdapter } = require("./platform-adapter");
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
  let server = null;
  let inputMonitor = null;
  let hookManager = null;
  let integrationManager = null;
  let settings = null;
  let logger = null;
  let updateManager = null;
  let shutdownCoordinator = null;
  let localization = createLocalizer({ preference: "system", systemLocale: "en-US" });
  const t = (key, params) => localization.t(key, params);
  const approvals = new ApprovalStore();
  const completions = new CompletionStore();
  const inputRequests = new InputRequestStore();

  function shutdownServices(reason = "quit") {
    if (!shutdownCoordinator) {
      shutdownCoordinator = new ShutdownCoordinator({
        logger: logger || { warn() {} },
        steps: [
          {
            name: "server",
            run: async () => {
              const activeServer = server;
              server = null;
              if (activeServer) await activeServer.stop();
              else approvals.shutdown();
            },
          },
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
    return [
      t("diagnostics.application", { appName: APP_NAME, version: app.getVersion() }),
      t("diagnostics.platform", { platform: platform.platform, arch: platform.arch, packageKind: platform.packageKind }),
      t("diagnostics.windowBackend", { value: platform.windowBackend }),
      ...(platform.degradedReason ? [t("diagnostics.platformDegraded", { reason: translateReason(localization, platform.degradedReason) })] : []),
      t("diagnostics.autoUpdate", { value: updateValues }),
      t("diagnostics.localService", { value: local.listening ? `127.0.0.1:${local.port}` : t("diagnostics.notRunning") }),
      t("diagnostics.approvals", { value: settings.get("approvalEnabled") ? t("diagnostics.enabled") : t("diagnostics.disabled") }),
      t("diagnostics.inputReminders", { value: settings.get("inputReminderEnabled") ? t("diagnostics.enabled") : t("diagnostics.disabled") }),
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
      t("diagnostics.sessionDirectory", { path: input.sessionsDir }),
      t("diagnostics.sessionMonitorError", { error: input.lastError || t("diagnostics.none") }),
      t("diagnostics.logs", { path: logger.filePath }),
    ].join("\n");
  }

  function trayImage() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="5" width="28" height="22" rx="11" fill="#111318"/><circle cx="10" cy="16" r="3" fill="#72e5a5"/><path d="M17 12h7M17 16h7M17 20h5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const image = nativeImage.createFromDataURL(dataUrl);
    const resized = image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
    return platformAdapter.configureTrayImage(resized);
  }

  function showSystemNotification(title, body) {
    return platformAdapter.showNotification({ tray, Notification, title, body });
  }

  function setLanguage(preference) {
    if (!settings?.set("language", preference)) return false;
    localization.setPreference(preference);
    if (island) island.refresh("language");
    else rebuildTray();
    return true;
  }

  function rebuildTray() {
    if (!tray) return;
    const hook = hookManager.status();
    const local = server ? server.status() : { listening: false, port: null };
    const descriptors = listAgents();
    const statuses = new Map(descriptors.map(descriptor => [descriptor.id, integrationManager.status(descriptor.id)]));
    const healthyCount = descriptors.filter(descriptor => statuses.get(descriptor.id).healthy).length;
    const detectedCount = descriptors.filter(descriptor => statuses.get(descriptor.id).detected).length;
    const statusLabel = !local.listening
      ? t("tray.serviceNotRunning")
      : hook.feature === "false"
        ? t("tray.codexHooksDisabled")
        : hook.trust.pendingCount > 0
          ? t("tray.codexHookPending")
          : t("tray.integrationsHealthy", { healthy: healthyCount, detected: detectedCount });
    const integrationItems = descriptors.map(descriptor => {
      const state = settings.getIntegration(descriptor.id);
      const status = statuses.get(descriptor.id);
      const suffix = state.disabledByUser
        ? t("tray.integrationDisabledByUser")
        : status.disabled
          ? t("tray.integrationDisabledByClient")
          : status.healthy
            ? t("tray.integrationHealthy")
            : status.detected
              ? t("tray.integrationNeedsRepair")
              : t("tray.integrationNotDetected");
      return {
        label: `${descriptor.name} (${suffix})`,
        type: "checkbox",
        checked: !state.disabledByUser,
        enabled: status.detected || state.disabledByUser,
        click: item => {
          const result = item.checked ? integrationManager.enable(descriptor.id) : integrationManager.disable(descriptor.id);
          if (!result?.ok && item.checked) {
            dialog.showMessageBox({
              type: "warning",
              title: APP_NAME,
              message: t("dialog.integrationEnableFailed", { agentName: descriptor.name }),
              detail: translateReason(localization, result?.reason),
            });
          }
          rebuildTray();
        },
      };
    });
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
      { label: statusLabel, enabled: false },
      { type: "separator" },
      ...updateItems,
      { type: "separator" },
      {
        label: t("tray.enableApprovals"),
        type: "checkbox",
        checked: settings.get("approvalEnabled"),
        click: item => { settings.set("approvalEnabled", item.checked); rebuildTray(); },
      },
      {
        label: t("tray.inputReminders"),
        type: "checkbox",
        checked: settings.get("inputReminderEnabled"),
        click: item => {
          settings.set("inputReminderEnabled", item.checked);
          if (item.checked) inputMonitor?.replayPending();
          else inputRequests.clear("disabled");
          rebuildTray();
        },
      },
      {
        label: t("tray.launchAtLogin"),
        type: "checkbox",
        checked: settings.get("openAtLogin"),
        click: item => { setLogin(item.checked); rebuildTray(); },
      },
      {
        label: t("tray.clientIntegrations"),
        submenu: [
          ...integrationItems,
          { type: "separator" },
          {
            label: t("tray.rescan"),
            click: () => { integrationManager.scan({ install: true }); rebuildTray(); },
          },
          {
            label: t("tray.repairAll"),
            click: () => { integrationManager.repairAll(); rebuildTray(); },
          },
          {
            label: t("tray.uninstallAll"),
            click: async () => {
              const result = await dialog.showMessageBox({
                type: "warning", buttons: [t("dialog.cancel"), t("dialog.uninstallAll")], defaultId: 0, cancelId: 0,
                title: APP_NAME, message: t("dialog.removeAllIntegrations"),
                detail: t("dialog.removeAllIntegrationsDetail"),
              });
              if (result.response === 1) {
                integrationManager.uninstallAll();
                for (const descriptor of listAgents()) settings.setIntegration(descriptor.id, { disabledByUser: true, installed: false, healthy: false, reason: "disabled-by-user" });
                rebuildTray();
              }
            },
          },
        ],
      },
      {
        label: t("tray.language"),
        submenu: [
          {
            label: t("tray.followSystem"),
            type: "radio",
            checked: settings.get("language") === "system",
            click: () => setLanguage("system"),
          },
          {
            label: "English",
            type: "radio",
            checked: settings.get("language") === "en-US",
            click: () => setLanguage("en-US"),
          },
          {
            label: "简体中文",
            type: "radio",
            checked: settings.get("language") === "zh-CN",
            click: () => setLanguage("zh-CN"),
          },
        ],
      },
    ];
    if (hook.feature === "false") {
      items.push({
        label: t("tray.enableCodexHooks"),
        click: async () => {
          const result = await dialog.showMessageBox({
            type: "question",
            buttons: [t("dialog.cancel"), t("dialog.enable")],
            defaultId: 1,
            cancelId: 0,
            title: APP_NAME,
            message: t("dialog.enableCodexHooksQuestion"),
          });
          if (result.response === 1) {
            hookManager.enableFeature();
            settings.setIntegration("codex", { disabledByUser: false });
            integrationManager.enable("codex");
            rebuildTray();
          }
        },
      });
    }
    if (hook.trust.pendingCount > 0) {
      items.push({
        label: t("tray.reviewCodexHook"),
        click: async () => {
          const result = await dialog.showMessageBox({
            type: "warning",
            buttons: [t("renderer.close"), t("dialog.copyHooks")],
            defaultId: 1,
            cancelId: 0,
            title: APP_NAME,
            message: t("dialog.codexHookUntrusted"),
            detail: t("dialog.codexHookUntrustedDetail"),
          });
          if (result.response === 1) clipboard.writeText("/hooks");
        },
      });
    }
    items.push(
      {
        label: t("tray.repairCodexHook"),
        click: async () => {
          settings.setIntegration("codex", { disabledByUser: false });
          const result = integrationManager.enable("codex");
          rebuildTray();
          await dialog.showMessageBox({
            type: result.ok ? "info" : "error",
            title: APP_NAME,
            message: result.ok ? t("dialog.codexHookRepaired") : t("dialog.codexHookRepairFailed"),
            detail: result.reason ? translateReason(localization, result.reason) : (hookManager.status().trust.pendingCount > 0
              ? t("dialog.codexHookReviewStillRequired")
              : t("dialog.hooksFeatureState", { state: result.feature })),
          });
        },
      },
      {
        label: t("tray.diagnostics"),
        click: async () => {
          const detail = diagnosticText();
          const result = await dialog.showMessageBox({
            type: "info",
            buttons: [t("renderer.close"), t("dialog.copy"), t("dialog.openLogDirectory")],
            defaultId: 0,
            title: t("dialog.diagnosticsTitle", { appName: APP_NAME }),
            message: t("dialog.runtimeStatus"),
            detail,
          });
          if (result.response === 1) clipboard.writeText(detail);
          if (result.response === 2) shell.openPath(path.dirname(logger.filePath));
        },
      },
      { type: "separator" },
      { label: t("tray.quit"), click: () => requestQuit() },
    );
    tray.setContextMenu(Menu.buildFromTemplate(items));
    tray.setToolTip(`${APP_NAME} — ${statusLabel}`);
  }

  function handleAgentEvent(data) {
    if (data.codex_session_role === "subagent") return;
    const descriptor = agent(data.agentId || data.agent_id) || agent("codex");
    const agentId = descriptor.id;
    const agentName = descriptor.name;
    const sessionId = typeof data.sessionId === "string" ? data.sessionId
      : (typeof data.session_id === "string" ? data.session_id : `${agentId}:unknown`);
    if (data.event === "UserPromptSubmit") {
      completions.clear("new-prompt", sessionId, agentId);
      inputRequests.clearSession(sessionId, "new-prompt", agentId);
      return;
    }
    if (data.event === "PermissionRequest" && descriptor.capabilities.passiveApproval) {
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
    inputRequests.clearSession(sessionId, "session-stopped", agentId);
    if (approvals.size > 0 || inputRequests.size > 0) return;
    const cwd = typeof data.cwd === "string" ? data.cwd : "";
    completions.show({
      sessionId,
      agentId,
      agentName,
      title: typeof data.session_title === "string" && data.session_title.trim()
        ? data.session_title.trim()
        : (cwd ? path.basename(cwd) : ""),
      titleKey: cwd ? "" : "fallback.completionTitle",
      titleParams: { agentName },
      output: typeof data.assistant_last_output === "string" ? data.assistant_last_output : "",
      outputKey: typeof data.assistant_last_output === "string" ? "" : "fallback.taskCompleted",
      cwd,
      sourcePid: Number.isInteger(data.source_pid) ? data.source_pid : null,
      pidChain: Array.isArray(data.pid_chain) ? data.pid_chain : [],
    });
  }

  app.on("second-instance", () => {
    showSystemNotification(APP_NAME, t("notification.background"));
  });

  app.on("window-all-closed", event => event?.preventDefault?.());

  app.whenReady().then(async () => {
    platformAdapter.configureReady(app);
    logger = createLogger(path.join(app.getPath("userData"), "logs"));
    settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
    localization = createLocalizer({ preference: settings.get("language"), systemLocale: app.getLocale() });
    integrationManager = createIntegrationManager(logger, settings);
    hookManager = integrationManager.codexManager;
    if (!settings.get("initialized")) {
      setLogin(true);
      settings.set("initialized", true);
    }

    const integrationResults = integrationManager.scan({ install: true });
    for (const result of integrationResults) {
      if (result.detected && !result.disabledByUser && !result.installResult?.ok) {
        logger.warn("Client integration not installed", { agentId: result.agent.id, reason: result.installResult?.reason || result.reason });
      }
    }

    island = new IslandController({
      BrowserWindow,
      clipboard,
      completionStore: completions,
      inputRequestStore: inputRequests,
      ipcMain,
      logger,
      nativeTheme,
      approvalStore: approvals,
      screen,
      localization,
      platformAdapter,
      onChanged: () => rebuildTray(),
    });
    island.create();

    inputMonitor = new CodexInputMonitor({
      logger,
      onRequested: request => {
        if (!settings.get("inputReminderEnabled")) return false;
        return !!inputRequests.enqueue({ ...request, agentId: "codex", agentName: "Codex" }).entry;
      },
      onResolved: request => inputRequests.resolve(request.requestKey),
    });
    inputMonitor.start();

    server = new IslandServer({
      approvalStore: approvals,
      isApprovalEnabled: () => settings.get("approvalEnabled"),
      logger,
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

    tray = new Tray(trayImage());
    tray.on("click", () => {
      if (approvals.current) island.expand(approvals.current.id);
      else if (inputRequests.current) island.expand(inputRequests.current.id);
      else if (completions.current) island.expand(completions.current.id);
    });
    rebuildTray();
    updateManager.start();
    logger.info("Application ready", { version: app.getVersion(), packaged: app.isPackaged, ...platformAdapter.status() });
    if (process.env.VIBE_HALO_TEST === "1" && process.argv.includes("--demo-approval")) {
      const demo = approvals.enqueue({
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
      if (process.argv.includes("--demo-expanded")) {
        setTimeout(() => island.expand(demo.id), 180);
      }
      if (process.env.VIBE_HALO_SMOKE_ACTION_FILE) {
        setTimeout(async () => {
          try {
            await island.window.webContents.executeJavaScript("document.querySelector('#actions button.primary')?.click()", true);
            setTimeout(() => {
              try {
                fs.mkdirSync(path.dirname(process.env.VIBE_HALO_SMOKE_ACTION_FILE), { recursive: true });
                fs.writeFileSync(process.env.VIBE_HALO_SMOKE_ACTION_FILE, approvals.size === 0 ? "resolved\n" : "pending\n");
              } catch {}
            }, 180);
          } catch (error) {
            logger.warn("Demo approval click failed", { message: error.message });
          }
        }, 700);
      }
      if (process.env.VIBE_HALO_SCREENSHOT) {
        setTimeout(async () => {
          try {
            const image = await island.window.webContents.capturePage();
            fs.mkdirSync(path.dirname(process.env.VIBE_HALO_SCREENSHOT), { recursive: true });
            fs.writeFileSync(process.env.VIBE_HALO_SCREENSHOT, image.toPNG());
          } catch (error) {
            logger.warn("Demo screenshot failed", { message: error.message });
          }
        }, 1400);
      }
    }
    if (process.argv.includes("--smoke-test")) {
      const smokeDelay = process.env.VIBE_HALO_SCREENSHOT ? 2600 : 1500;
      setTimeout(() => requestQuit(), smokeDelay);
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
