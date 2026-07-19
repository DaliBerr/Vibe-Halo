"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { listAgents } = require("../src/agent-registry");
const { HookManager } = require("../src/hook-manager");
const { IntegrationManager, addJsonHooks, commandFor, isHealthyZcodeProcessHook, readJson } = require("../src/integration-manager");
const {
  buildDesktopEntry,
  buildPosixRunner,
  createPlatformAdapter,
  packageKind,
  posixQuote,
  selectLinuxWindowBackend,
} = require("../src/platform-adapter");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(platform = "linux", env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-platform-"));
  roots.push(root);
  const homeDir = path.join(root, "home");
  const runtimeRoot = path.join(root, "runtime");
  const executablePath = platform === "darwin"
    ? "/Applications/Vibe Halo.app/Contents/MacOS/Vibe Halo"
    : "/tmp/.mount_vibe/vibe-halo";
  const adapter = createPlatformAdapter({ platform, env, homeDir, runtimeRoot, executablePath, packaged: true });
  const source = path.join(root, "vibe-halo-hook.js");
  fs.writeFileSync(source, "process.stdout.write('{}');\n");
  return { adapter, executablePath, homeDir, root, runtimeRoot, source };
}

test("selects bounded platform and Wayland backends", () => {
  assert.equal(selectLinuxWindowBackend({ XDG_SESSION_TYPE: "x11" }), "x11");
  assert.equal(selectLinuxWindowBackend({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }), "xwayland");
  assert.equal(selectLinuxWindowBackend({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0", VIBE_HALO_NATIVE_WAYLAND: "1" }), "wayland-degraded");
  assert.equal(selectLinuxWindowBackend({ XDG_SESSION_TYPE: "wayland" }), "wayland-degraded");
  assert.equal(selectLinuxWindowBackend({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }), "xwayland");
  assert.equal(packageKind("linux", { APPIMAGE: "/apps/Vibe.AppImage" }, true), "appimage");
  assert.equal(packageKind("linux", {}, true), "deb");
  assert.equal(packageKind("darwin", {}, true), "dmg-or-zip");
});

test("selects the requested Electron ozone backend before app readiness", () => {
  const switches = [];
  fixture("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }).adapter.configureEarly({
    commandLine: { appendSwitch(name, value) { switches.push([name, value]); } },
  });
  fixture("linux", { XDG_SESSION_TYPE: "wayland", VIBE_HALO_NATIVE_WAYLAND: "1" }).adapter.configureEarly({
    commandLine: { appendSwitch(name, value) { switches.push([name, value]); } },
  });
  assert.deepEqual(switches, [["ozone-platform", "x11"], ["ozone-platform", "wayland"]]);
});

test("quotes POSIX commands and desktop entries without exposing shell syntax", () => {
  assert.equal(posixQuote("/tmp/Vibe Halo's/app"), "'/tmp/Vibe Halo'\\''s/app'");
  assert.match(buildPosixRunner("/Applications/Vibe Halo", "/tmp/hook.js"), /exec '\/Applications\/Vibe Halo' '\/tmp\/hook\.js' "\$@"/);
  assert.match(buildDesktopEntry("/home/me/Vibe Halo.AppImage"), /^Exec="\/home\/me\/Vibe Halo\.AppImage"$/m);
});

test("installs a stable POSIX hook runner and keeps client commands stable", () => {
  const { adapter, source } = fixture("linux", { APPIMAGE: "/home/me/Vibe-Halo.AppImage" });
  const prepared = adapter.prepareHookRuntime(source);
  assert.equal(prepared.runnerPath, adapter.runnerPath);
  assert.equal(prepared.hookScriptPath, adapter.managedHookPath);
  assert.match(fs.readFileSync(adapter.runnerPath, "utf8"), /ELECTRON_RUN_AS_NODE=1/);
  assert.match(fs.readFileSync(adapter.runnerPath, "utf8"), /'\/home\/me\/Vibe-Halo\.AppImage'/);
  assert.doesNotMatch(fs.readFileSync(adapter.runnerPath, "utf8"), /\.mount_vibe/);
  assert.match(adapter.hookCommand("codex", "Stop"), /vibe-halo-hook-runner'.*--agent 'codex'.*--event 'Stop'/);
  assert.equal(adapter.processHook("zcode", "PermissionRequest", 135000).command, adapter.runnerPath);
});

test("generates healthy macOS and Linux ZCode process hooks", () => {
  for (const platform of ["darwin", "linux"]) {
    const { adapter, executablePath, source } = fixture(platform);
    adapter.prepareHookRuntime(source);
    const config = addJsonHooks("zcode", {}, executablePath, adapter.managedHookPath, { platform, platformAdapter: adapter });
    const hook = config.hooks.events.PermissionRequest[0].hooks[0];
    assert.equal(hook.command, adapter.runnerPath);
    assert.deepEqual(hook.args, ["--agent", "zcode", "--event", "PermissionRequest"]);
    assert.equal(isHealthyZcodeProcessHook(hook, "PermissionRequest", { platform, platformAdapter: adapter }), true);
  }
});

test("Codex and every registered adapter declare all three platform contracts", () => {
  for (const descriptor of listAgents()) {
    assert.deepEqual(descriptor.platforms, { win32: true, darwin: true, linux: true });
  }
  for (const platform of ["darwin", "linux"]) {
    const { adapter, executablePath, homeDir, root, source } = fixture(platform);
    adapter.prepareHookRuntime(source);
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), "[features]\nhooks = true\n");
    const manager = new HookManager({
      platform,
      platformAdapter: adapter,
      executablePath,
      hookScriptPath: adapter.managedHookPath,
      paths: {
        codexDir,
        hooksPath: path.join(codexDir, "hooks.json"),
        configPath: path.join(codexDir, "config.toml"),
        migrationPath: path.join(root, "migration.json"),
        backupDir: path.join(root, "backups"),
      },
    });
    assert.equal(manager.install().ok, true);
    const installed = JSON.parse(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"));
    assert.match(installed.hooks.PermissionRequest[0].hooks[0].command, /vibe-halo-hook-runner/);
    assert.doesNotMatch(JSON.stringify(installed), /cmd\.exe|powershell/i);
  }
});

test("installs and safely removes every non-Codex adapter on macOS and Linux fixtures", () => {
  const jsonAgents = [
    "zcode", "qwen-code", "copilot-cli", "claude-code", "codebuddy", "gemini-cli",
    "antigravity", "cursor-agent", "qoder", "qoderwork", "reasonix",
  ];
  for (const platform of ["darwin", "linux"]) {
    const { adapter, executablePath, homeDir, root, source } = fixture(platform);
    adapter.prepareHookRuntime(source);
    const manager = new IntegrationManager({
      platform,
      platformAdapter: adapter,
      homeDir,
      executablePath,
      hookScriptPath: adapter.managedHookPath,
      backupRoot: path.join(root, "backups"),
    });
    for (const agentId of jsonAgents) {
      const target = manager.paths(agentId)[0];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{"thirdParty":{"keep":true}}\n');
    }
    const kiroDir = manager.paths("kiro")[0];
    fs.mkdirSync(kiroDir, { recursive: true });
    fs.writeFileSync(path.join(kiroDir, "default.json"), '{"thirdParty":{"keep":true}}\n');
    for (const agentId of ["kimi-code", "codewhale"]) {
      const target = manager.paths(agentId)[0];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'model = "third-party"\n');
    }
    for (const agentId of ["opencode", "openclaw"]) {
      const target = manager.paths(agentId)[0];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, agentId === "opencode" ? '{"plugin":[],"thirdParty":true}\n' : '{"plugins":{},"thirdParty":true}\n');
    }
    fs.mkdirSync(manager.paths("pi")[0], { recursive: true });
    fs.mkdirSync(manager.paths("hermes")[0], { recursive: true });

    for (const agentId of [...jsonAgents, "kiro", "kimi-code", "codewhale", "opencode", "pi", "openclaw", "hermes"]) {
      const result = manager.install(agentId);
      if (agentId !== "hermes") assert.equal(result.ok, true, `${platform}:${agentId}:${result.reason || "failed"}`);
      const serialized = manager.paths(agentId).filter(fs.existsSync).map(target => (
        fs.statSync(target).isFile() ? fs.readFileSync(target, "utf8") : ""
      )).join("\n");
      if (serialized) assert.doesNotMatch(serialized, /cmd\.exe|powershell\.exe/i, `${platform}:${agentId}`);
      assert.equal(manager.uninstall(agentId).ok, true, `${platform}:${agentId}`);
    }
    for (const agentId of jsonAgents) assert.equal(readJson(manager.paths(agentId)[0]).thirdParty.keep, true, `${platform}:${agentId}`);
    assert.equal(readJson(manager.paths("opencode")[0]).thirdParty, true);
    assert.equal(readJson(manager.paths("openclaw")[0]).thirdParty, true);
  }
});

test("uses POSIX Reasonix paths and removes managed runtime only on uninstall-all", () => {
  const { adapter, executablePath, homeDir, root, source } = fixture("linux");
  adapter.prepareHookRuntime(source);
  const manager = new IntegrationManager({
    platform: "linux",
    platformAdapter: adapter,
    homeDir,
    executablePath,
    hookScriptPath: adapter.managedHookPath,
    backupRoot: path.join(root, "backups"),
  });
  assert.equal(manager.paths("reasonix")[0], path.join(homeDir, ".reasonix", "settings.json"));
  assert.equal(fs.existsSync(adapter.runnerPath), true);
  manager.uninstallAll();
  assert.equal(fs.existsSync(adapter.runnerPath), false);
});

test("writes POSIX TOML hook commands as valid quoted strings without changing shell quoting", () => {
  const { adapter, executablePath, homeDir, root, source } = fixture("linux");
  adapter.prepareHookRuntime(source);
  const manager = new IntegrationManager({
    platform: "linux",
    platformAdapter: adapter,
    homeDir,
    executablePath,
    hookScriptPath: adapter.managedHookPath,
    backupRoot: path.join(root, "backups"),
  });
  for (const [agentId, target] of [
    ["kimi-code", path.join(homeDir, ".kimi-code", "config.toml")],
    ["codewhale", path.join(homeDir, ".codewhale", "config.toml")],
  ]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
    assert.equal(manager.install(agentId).ok, true);
    const commandLiteral = fs.readFileSync(target, "utf8").match(/^command = (".*")$/m)?.[1];
    assert.ok(commandLiteral, agentId);
    const command = JSON.parse(commandLiteral);
    assert.match(command, /vibe-halo-hook-runner/);
    assert.match(command, /^'.*vibe-halo-hook-runner'/);
  }
});

test("POSIX command generation never emits Windows launchers", () => {
  const { adapter, executablePath } = fixture("linux");
  const command = commandFor(executablePath, adapter.managedHookPath, "qwen-code", "Stop", { platform: "linux", platformAdapter: adapter });
  assert.match(command, /vibe-halo-hook-runner/);
  assert.doesNotMatch(command, /cmd\.exe|powershell/i);
});

test("delegates login startup, tray style, and notifications by platform", () => {
  const linux = fixture("linux").adapter;
  assert.equal(linux.setLoginItem(null, true), true);
  const desktopPath = path.join(linux.homeDir, ".config", "autostart", "com.vibe.halo.desktop");
  assert.match(fs.readFileSync(desktopPath, "utf8"), /X-GNOME-Autostart-enabled=true/);
  linux.setLoginItem(null, false);
  assert.equal(fs.existsSync(desktopPath), false);

  const mac = fixture("darwin").adapter;
  let template = false;
  mac.configureTrayImage({ setTemplateImage(value) { template = value; } });
  assert.equal(template, true);
  let shown = false;
  class FakeNotification {
    static isSupported() { return true; }
    show() { shown = true; }
  }
  assert.equal(mac.showNotification({ Notification: FakeNotification, title: "Vibe Halo", body: "Done" }), true);
  assert.equal(shown, true);

  const windows = fixture("win32").adapter;
  let balloon = null;
  assert.equal(windows.showNotification({
    tray: { displayBalloon(value) { balloon = value; } },
    title: "Vibe Halo",
    body: "Done",
  }), true);
  assert.deepEqual(balloon, { title: "Vibe Halo", content: "Done" });
});
