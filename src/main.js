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
const { IntegrationManager } = require("./integration-manager");
const { IslandController } = require("./island-controller");
const { InputRequestStore } = require("./input-request-store");
const { createLogger } = require("./logger");
const { IslandServer } = require("./server");
const { SettingsStore } = require("./settings-store");

app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
if (process.env.VIBE_HALO_USER_DATA) app.setPath("userData", process.env.VIBE_HALO_USER_DATA);

function hookScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "hooks", "vibe-halo-hook.js")
    : path.join(__dirname, "..", "hooks", "vibe-halo-hook.js");
}

function createHookManager(logger) {
  return new HookManager({
    executablePath: process.execPath,
    hookScriptPath: hookScriptPath(),
    logger,
  });
}

function integrationAssetPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "hooks", "integrations")
    : path.join(__dirname, "..", "hooks", "integrations");
}

function createIntegrationManager(logger, settings) {
  const codexManager = createHookManager(logger);
  return new IntegrationManager({
    assetRoot: integrationAssetPath(),
    backupRoot: path.join(app.getPath("userData"), "integration-backups"),
    codexManager,
    executablePath: process.execPath,
    hookScriptPath: hookScriptPath(),
    logger,
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
  let quitting = false;
  const approvals = new ApprovalStore();
  const completions = new CompletionStore();
  const inputRequests = new InputRequestStore();

  function setLogin(enabled) {
    try {
      if (process.env.VIBE_HALO_TEST !== "1") {
        app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
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
      const verification = state.verification === "live" ? "本机实测" : (state.verification === "contract" ? "契约测试通过、未在本机实测" : "未验证");
      return `${descriptor.name}：${state.disabledByUser ? "用户停用" : (status.disabled ? "客户端已禁用 Hook" : (status.healthy ? "健康" : (status.detected ? "需修复" : "未检测")))}；${verification}`;
    });
    return [
      `应用：${APP_NAME} ${app.getVersion()}`,
      `本地服务：${local.listening ? `127.0.0.1:${local.port}` : "未运行"}`,
      `审批：${settings.get("approvalEnabled") ? "启用" : "停用"}`,
      `等待输入提醒：${settings.get("inputReminderEnabled") ? "启用" : "停用"}`,
      "客户端集成：",
      ...integrations.map(value => `  ${value}`),
      `待审批：${approvals.size}`,
      `等待输入：${inputRequests.size}`,
      `Codex 目录：${hook.codexHomeExists ? "已找到" : "未找到"}`,
      `Hooks 功能：${hook.feature}`,
      `Hook 事件：${Object.entries(hook.events).map(([key, value]) => `${key}=${value ? "ok" : "missing"}`).join(", ")}`,
      `Hook 信任：${Object.entries(hook.trust.events).map(([key, value]) => `${key}=${value}`).join(", ")}`,
      `运行时：${local.runtimePath}`,
      `会话监控：${input.running ? "运行中" : "未运行"}, 目录=${input.sessionsFound ? "已找到" : "未找到"}, 文件=${input.trackedFiles}, 待响应=${input.pendingCount}`,
      `会话目录：${input.sessionsDir}`,
      `会话监控错误：${input.lastError || "无"}`,
      `日志：${logger.filePath}`,
    ].join("\n");
  }

  function trayImage() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="5" width="28" height="22" rx="11" fill="#111318"/><circle cx="10" cy="16" r="3" fill="#72e5a5"/><path d="M17 12h7M17 16h7M17 20h5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const image = nativeImage.createFromDataURL(dataUrl);
    return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
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
      ? "服务未运行"
      : hook.feature === "false"
        ? "Codex Hooks 已禁用"
        : hook.trust.pendingCount > 0
          ? "Codex Hook 待审核"
        : `客户端集成 ${healthyCount}/${detectedCount} 健康`;
    const integrationItems = descriptors.map(descriptor => {
      const state = settings.getIntegration(descriptor.id);
      const status = statuses.get(descriptor.id);
      const suffix = state.disabledByUser ? "（已停用）" : status.disabled ? "（客户端禁用）" : status.healthy ? "（健康）" : status.detected ? "（需修复）" : "（未检测）";
      return {
        label: `${descriptor.name} ${suffix}`,
        type: "checkbox",
        checked: !state.disabledByUser,
        enabled: status.detected || state.disabledByUser,
        click: item => {
          const result = item.checked ? integrationManager.enable(descriptor.id) : integrationManager.disable(descriptor.id);
          if (!result?.ok && item.checked) {
            dialog.showMessageBox({ type: "warning", title: APP_NAME, message: `${descriptor.name} 集成未能启用。`, detail: result?.reason || "未知错误" });
          }
          rebuildTray();
        },
      };
    });
    const items = [
      { label: statusLabel, enabled: false },
      { type: "separator" },
      {
        label: "启用审批",
        type: "checkbox",
        checked: settings.get("approvalEnabled"),
        click: item => { settings.set("approvalEnabled", item.checked); rebuildTray(); },
      },
      {
        label: "等待输入提醒",
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
        label: "开机启动",
        type: "checkbox",
        checked: settings.get("openAtLogin"),
        click: item => { setLogin(item.checked); rebuildTray(); },
      },
      {
        label: "客户端集成",
        submenu: [
          ...integrationItems,
          { type: "separator" },
          {
            label: "重新扫描",
            click: () => { integrationManager.scan({ install: true }); rebuildTray(); },
          },
          {
            label: "修复全部",
            click: () => { integrationManager.repairAll(); rebuildTray(); },
          },
          {
            label: "卸载全部…",
            click: async () => {
              const result = await dialog.showMessageBox({
                type: "warning", buttons: ["取消", "卸载全部"], defaultId: 0, cancelId: 0,
                title: APP_NAME, message: "移除所有 Vibe Halo 客户端集成？",
                detail: "第三方配置和首次备份会保留；所有客户端将回到原生流程。",
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
    ];
    if (hook.feature === "false") {
      items.push({
        label: "启用 Codex Hooks…",
        click: async () => {
          const result = await dialog.showMessageBox({
            type: "question",
            buttons: ["取消", "启用"],
            defaultId: 1,
            cancelId: 0,
            title: APP_NAME,
            message: "Codex config.toml 明确禁用了 Hooks。是否将 hooks 设置为 true？",
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
        label: "审核 Codex Hook…",
        click: async () => {
          const result = await dialog.showMessageBox({
            type: "warning",
            buttons: ["关闭", "复制 /hooks"],
            defaultId: 1,
            cancelId: 0,
            title: APP_NAME,
            message: "Codex 尚未信任 Vibe Halo Hook",
            detail: "请在 Codex 的输入框中执行 /hooks，找到用户级 ~/.codex/hooks.json，并审核、信任 Vibe Halo 的 PermissionRequest、Stop 和 UserPromptSubmit 条目。Codex 官方目前没有可供本地安装器调用的安全信任 API。",
          });
          if (result.response === 1) clipboard.writeText("/hooks");
        },
      });
    }
    items.push(
      {
        label: "修复 Codex Hook",
        click: async () => {
          settings.setIntegration("codex", { disabledByUser: false });
          const result = integrationManager.enable("codex");
          rebuildTray();
          await dialog.showMessageBox({
            type: result.ok ? "info" : "error",
            title: APP_NAME,
            message: result.ok ? "Codex Hook 配置已检查并修复。" : "无法修复 Codex Hook。",
            detail: result.reason || (hookManager.status().trust.pendingCount > 0
              ? "配置已写入，但仍需在 Codex 输入 /hooks，审核并信任 Vibe Halo 条目。"
              : `Hooks 功能状态：${result.feature}`),
          });
        },
      },
      {
        label: "诊断信息",
        click: async () => {
          const detail = diagnosticText();
          const result = await dialog.showMessageBox({
            type: "info",
            buttons: ["关闭", "复制", "打开日志目录"],
            defaultId: 0,
            title: `${APP_NAME} 诊断`,
            message: "运行状态",
            detail,
          });
          if (result.response === 1) clipboard.writeText(detail);
          if (result.response === 2) shell.openPath(path.dirname(logger.filePath));
        },
      },
      { type: "separator" },
      { label: "退出", click: () => { quitting = true; app.quit(); } },
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
        title: `${agentName} 等待原生审批`,
        content: `请在 ${agentName} 客户端中完成 ${data.toolName || data.tool_name || "工具"} 审批。`,
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
        : (cwd ? path.basename(cwd) : `${agentName} 已完成`),
      output: typeof data.assistant_last_output === "string" ? data.assistant_last_output : "任务已完成",
      cwd,
      sourcePid: Number.isInteger(data.source_pid) ? data.source_pid : null,
      pidChain: Array.isArray(data.pid_chain) ? data.pid_chain : [],
    });
  }

  app.on("second-instance", () => {
    if (tray && process.platform === "win32") {
      try { tray.displayBalloon({ title: APP_NAME, content: "Vibe Halo 已在后台运行。" }); } catch {}
    }
  });

  app.on("window-all-closed", event => event?.preventDefault?.());

  app.whenReady().then(async () => {
    logger = createLogger(path.join(app.getPath("userData"), "logs"));
    settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
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

    tray = new Tray(trayImage());
    tray.on("click", () => {
      if (approvals.current) island.expand(approvals.current.id);
      else if (inputRequests.current) island.expand(inputRequests.current.id);
      else if (completions.current) island.expand(completions.current.id);
    });
    rebuildTray();
    logger.info("Application ready", { version: app.getVersion(), packaged: app.isPackaged });
    if (process.env.VIBE_HALO_TEST === "1" && process.argv.includes("--demo-approval")) {
      const demo = approvals.enqueue({
        agentId: "codex",
        agentName: "Codex",
        kind: "approval",
        options: [
          { id: "allow", label: "允许一次", tone: "primary" },
          { id: "deny", label: "拒绝", tone: "danger" },
          { id: "native", label: "在客户端处理", tone: "secondary", overflow: true },
        ],
        sessionId: "codex:demo",
        toolUseId: "demo-tool",
        toolName: "PowerShell",
        description: "运行完整测试套件并读取结果。这个说明故意较长，用于确认高 DPI 和多行文字下操作按钮仍保持可见。",
        toolInput: {
          command: "npm test -- --test-reporter=spec --test-concurrency=1",
          cwd: "C:\\Projects\\demo-with-a-longer-workspace-name",
          timeout_ms: 120000,
          description: "运行完整测试套件并读取结果。这个说明故意较长，用于确认高 DPI 和多行文字下操作按钮仍保持可见。",
          environment: { CI: "1", FORCE_COLOR: "0" },
        },
        cwd: "C:\\Projects\\demo",
        sourcePid: process.pid,
        pidChain: [process.pid],
      }, { complete() {} }).entry;
      if (process.argv.includes("--demo-expanded")) {
        setTimeout(() => island.expand(demo.id), 180);
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
      setTimeout(() => { quitting = true; app.quit(); }, smokeDelay);
    }
  }).catch(error => {
    try { logger?.error("Startup failed", { message: error.message }); } catch {}
    dialog.showErrorBox(APP_NAME, `启动失败：${error.message}`);
    quitting = true;
    app.quit();
  });

  app.on("before-quit", event => {
    if (quitting && !server) return;
    if (!quitting) quitting = true;
    if (server) {
      event.preventDefault();
      const activeServer = server;
      server = null;
      activeServer.stop().finally(() => {
        inputMonitor?.stop();
        inputRequests.clear("shutdown");
        island?.destroy();
        tray?.destroy();
        app.quit();
      });
    } else {
      inputMonitor?.stop();
      inputRequests.clear("shutdown");
    }
  });
}
