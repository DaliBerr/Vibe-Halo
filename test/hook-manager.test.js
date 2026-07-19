"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HookManager,
  buildHookCommand,
  enableHooksFeature,
  eventStateName,
  featureState,
  parseHookTrustStates,
} = require("../src/hook-manager");
const { MANAGED_EVENTS, OWN_HOOK_MARKER, PREVIOUS_HOOK_MARKER } = require("../src/constants");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(config = "[features]\nhooks = true\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-hook-"));
  roots.push(root);
  const codexDir = path.join(root, ".codex");
  const runtimeDir = path.join(root, ".vibe-halo");
  const backupDir = path.join(runtimeDir, "backups");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), config, "utf8");
  const legacyScript = path.join(root, "legacy", "codex-hook.js");
  fs.mkdirSync(path.dirname(legacyScript), { recursive: true });
  fs.writeFileSync(legacyScript, "// legacy", "utf8");
  const settings = {
    hooks: {
      PermissionRequest: [{ hooks: [
        { type: "command", command: `node \"${legacyScript}\"`, timeout: 600 },
        { type: "command", command: "third-party-permission", timeout: 12 },
      ] }],
      Stop: [{ hooks: [
        { type: "command", command: `node \"${legacyScript}\"`, timeout: 30 },
        { type: "command", command: "node codex-debug-hook.js", timeout: 30 },
      ] }],
      CustomEvent: [{ hooks: [{ type: "command", command: "custom" }] }],
    },
  };
  const hooksPath = path.join(codexDir, "hooks.json");
  fs.writeFileSync(hooksPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const hookScriptPath = path.resolve(__dirname, "..", "hooks", "vibe-halo-hook.js");
  const manager = new HookManager({
    platform: "win32",
    executablePath: "C:\\Program Files\\Vibe Halo\\Vibe Halo.exe",
    hookScriptPath,
    paths: {
      codexDir,
      hooksPath,
      configPath: path.join(codexDir, "config.toml"),
      migrationPath: path.join(runtimeDir, "hook-migration.json"),
      backupDir,
    },
  });
  return { manager, hooksPath, legacyScript, runtimeDir };
}

test("installer backs up, migrates legacy hooks and preserves third-party hooks", () => {
  const { manager, hooksPath, runtimeDir } = fixture();
  const result = manager.install();
  assert.equal(result.ok, true);
  assert.equal(result.migrated, 2);
  const settings = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const allCommands = JSON.stringify(settings);
  assert.equal(allCommands.includes("third-party-permission"), true);
  assert.equal(allCommands.includes("codex-debug-hook.js"), true);
  assert.equal(allCommands.includes("custom"), true);
  assert.equal(allCommands.includes("node \\\""), false);
  for (const event of MANAGED_EVENTS) {
    assert.equal(settings.hooks[event].some(entry => JSON.stringify(entry).includes(OWN_HOOK_MARKER)), true);
  }
  const migration = JSON.parse(fs.readFileSync(path.join(runtimeDir, "hook-migration.json"), "utf8"));
  assert.equal(migration.removed.length, 2);
  assert.equal(fs.existsSync(migration.backupPath), true);
});

test("repair is idempotent and reports explicit hooks=false", () => {
  const { manager, hooksPath } = fixture("[features]\nhooks = false\n");
  const first = manager.install();
  const before = fs.readFileSync(hooksPath, "utf8");
  const second = manager.install();
  assert.equal(first.feature, "false");
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(hooksPath, "utf8"), before);
  assert.equal(manager.status().healthy, false);
});

test("installer replaces the previous Clawd Island hook during rebranding", () => {
  const { manager, hooksPath } = fixture();
  const settings = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  settings.hooks.PermissionRequest.push({ hooks: [{
    type: "command",
    command: `node C:\\legacy\\${PREVIOUS_HOOK_MARKER}`,
    timeout: 150,
  }] });
  fs.writeFileSync(hooksPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  manager.install();

  const installed = fs.readFileSync(hooksPath, "utf8");
  assert.equal(installed.includes(PREVIOUS_HOOK_MARKER), false);
  assert.equal(installed.includes(OWN_HOOK_MARKER), true);
});

test("uninstall removes own hooks and safely restores existing legacy target", () => {
  const { manager, hooksPath, legacyScript } = fixture();
  manager.install();
  const result = manager.uninstall({ exists: candidate => candidate === legacyScript });
  assert.equal(result.removedOwn, 3);
  assert.equal(result.restored, 2);
  const text = fs.readFileSync(hooksPath, "utf8");
  const restoredSettings = JSON.parse(text);
  const commands = Object.values(restoredSettings.hooks).flatMap(entries => entries)
    .flatMap(entry => entry.hooks || []).map(hook => hook.command || hook.commandWindows || "");
  assert.equal(text.includes(OWN_HOOK_MARKER), false);
  assert.equal(commands.some(command => command.includes(legacyScript)), true);
  assert.equal(text.includes("third-party-permission"), true);
});

test("feature helpers preserve other TOML sections", () => {
  const input = "[ui]\ntheme = 'dark'\n\n[features]\nhooks = false\nother = true\n";
  const output = enableHooksFeature(input);
  assert.equal(featureState(input), "false");
  assert.equal(featureState(output), "true");
  assert.match(output, /theme = 'dark'/);
  assert.match(output, /other = true/);
});

test("Windows hook command waits for the Electron GUI executable through cmd.exe", () => {
  assert.equal(
    buildHookCommand("C:\\Program Files\\Vibe Halo\\Vibe Halo.exe", "C:\\Program Files\\Vibe Halo\\resources\\hook.js", [], { platform: "win32" }),
    "$env:ELECTRON_RUN_AS_NODE='1'; cmd.exe /d /s /c '\"C:\\Program Files\\Vibe Halo\\Vibe Halo.exe\" \"C:\\Program Files\\Vibe Halo\\resources\\hook.js\"'"
  );
});

test("health reports installed user hooks as pending until Codex trusts every handler", () => {
  const { manager } = fixture();
  manager.install();
  const status = manager.status();
  assert.equal(status.healthy, false);
  assert.equal(status.trust.pendingCount, 3);
  assert.deepEqual(status.trust.events, {
    PermissionRequest: "pending",
    Stop: "pending",
    UserPromptSubmit: "pending",
  });
});

test("health recognizes Codex trust state IDs without bypassing trust hashes", () => {
  const { manager, hooksPath } = fixture();
  manager.install();
  const settings = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const sections = [];
  for (const event of MANAGED_EVENTS) {
    settings.hooks[event].forEach((entry, groupIndex) => {
      (entry.hooks || []).forEach((handler, handlerIndex) => {
        if (!JSON.stringify(handler).includes(OWN_HOOK_MARKER)) return;
        const id = `${path.resolve(hooksPath)}:${eventStateName(event)}:${groupIndex}:${handlerIndex}`;
        sections.push(`[hooks.state.${JSON.stringify(id)}]\ntrusted_hash = "sha256:test-${event}"`);
      });
    });
  }
  fs.appendFileSync(manager.configPath, `\n${sections.join("\n\n")}\n`, "utf8");
  const parsed = parseHookTrustStates(fs.readFileSync(manager.configPath, "utf8"));
  assert.equal(parsed.size, 3);
  const status = manager.status();
  assert.equal(status.trust.pendingCount, 0);
  assert.equal(status.trust.healthy, true);
  assert.equal(status.healthy, true);
});

test("a user-disabled trusted handler is not healthy", () => {
  const { manager, hooksPath } = fixture();
  manager.install();
  const id = `${path.resolve(hooksPath)}:permission_request:1:0`;
  fs.appendFileSync(manager.configPath, `\n[hooks.state.${JSON.stringify(id)}]\nenabled = false\ntrusted_hash = "sha256:test"\n`, "utf8");
  const status = manager.status();
  assert.equal(status.trust.events.PermissionRequest, "disabled");
  assert.equal(status.healthy, false);
});
