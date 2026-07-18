"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  IntegrationManager,
  containsMarker,
  readJson,
  stripJsonComments,
} = require("../src/integration-manager");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-integrations-"));
  roots.push(root);
  const home = path.join(root, "home");
  const backupRoot = path.join(root, "backups");
  const hookScriptPath = path.join(root, "vibe-halo-hook.js");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(hookScriptPath, "// fixture\n");
  const manager = new IntegrationManager({
    homeDir: home,
    appData: path.join(root, "appdata"),
    backupRoot,
    executablePath: "C:\\Program Files\\Vibe Halo\\Vibe Halo.exe",
    hookScriptPath,
    assetRoot: path.resolve(__dirname, "..", "hooks", "integrations"),
    codexManager: {
      ensureCodexDir: () => false,
      install: () => ({ ok: false, reason: "missing" }),
      uninstall: () => ({ ok: true }),
      status: () => ({ codexHomeExists: false, events: {}, trust: { events: {}, healthy: false }, feature: "unset", healthy: false }),
    },
  });
  return { root, home, backupRoot, manager };
}

test("parses JSONC without damaging comment-like string values", () => {
  const value = JSON.parse(stripJsonComments('{ // note\n "url": "https://example.test/a//b", "items": [1,], /* tail */ }'));
  assert.equal(value.url, "https://example.test/a//b");
  assert.deepEqual(value.items, [1]);
});

test("installs exact ZCode process hooks, backs up once, and preserves third-party config", () => {
  const { home, backupRoot, manager } = fixture();
  const configPath = path.join(home, ".zcode", "cli", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ theme: "dark", hooks: { events: { Stop: [{ matcher: "third", hooks: [{ type: "process", command: "third-party" }] }] } } }, null, 2)}\n`);
  const first = manager.install("zcode");
  assert.equal(first.ok, true);
  const config = readJson(configPath);
  assert.equal(config.theme, "dark");
  assert.equal(config.hooks.enabled, true);
  assert.equal(config.hooks.maxOutputBytes, 32768);
  assert.equal(config.hooks.events.PermissionRequest[0].hooks[0].type, "process");
  assert.equal(config.hooks.events.Stop.some(entry => entry.hooks?.[0]?.command === "third-party"), true);
  assert.equal(containsMarker(config), true);
  const once = fs.readFileSync(configPath, "utf8");
  assert.equal(manager.install("zcode").ok, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), once);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, "zcode", "manifest.json"), "utf8"));
  assert.equal(Object.keys(manifest).length, 1);
  manager.uninstall("zcode");
  const cleaned = readJson(configPath);
  assert.equal(cleaned.theme, "dark");
  assert.equal(cleaned.hooks.events.Stop[0].hooks[0].command, "third-party");
  assert.equal(containsMarker(cleaned), false);
});

test("does not bypass explicit ZCode or Qwen hook disabling", () => {
  const { home, manager } = fixture();
  const zcode = path.join(home, ".zcode", "cli", "config.json");
  fs.mkdirSync(path.dirname(zcode), { recursive: true });
  fs.writeFileSync(zcode, '{"hooks":{"enabled":false},"keep":1}\n');
  const before = fs.readFileSync(zcode, "utf8");
  assert.deepEqual(manager.install("zcode"), { ok: false, disabled: true, reason: "hooks-explicitly-disabled", path: zcode });
  assert.equal(fs.readFileSync(zcode, "utf8"), before);

  const qwen = path.join(home, ".qwen", "settings.json");
  fs.mkdirSync(path.dirname(qwen), { recursive: true });
  fs.writeFileSync(qwen, '{"disableAllHooks":true,"keep":2}\n');
  assert.equal(manager.install("qwen-code").reason, "hooks-explicitly-disabled");
  assert.deepEqual(readJson(qwen), { disableAllHooks: true, keep: 2 });
});

test("detects initialized client homes and creates nested hook configs", () => {
  const { home, manager } = fixture();
  fs.mkdirSync(path.join(home, ".copilot"), { recursive: true });
  const detection = manager.detect("copilot-cli", { force: true });
  assert.equal(detection.detected, true);
  assert.equal(detection.reason, "config");
  const result = manager.install("copilot-cli");
  assert.equal(result.ok, true);
  const config = readJson(path.join(home, ".copilot", "hooks", "hooks.json"));
  assert.equal(config.hooks.permissionRequest.length, 1);
});

test("installs exact elicitation hooks for Claude and CodeBuddy", () => {
  const { home, manager } = fixture();
  for (const agentId of ["claude-code", "codebuddy"]) {
    const target = manager.paths(agentId)[0];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}\n");
    assert.equal(manager.install(agentId).ok, true);
    assert.equal(readJson(target).hooks.Elicitation.length, 1);
  }
});

test("merges and safely removes JSON and TOML integrations", () => {
  const { home, manager } = fixture();
  const cursor = path.join(home, ".cursor", "hooks.json");
  fs.mkdirSync(path.dirname(cursor), { recursive: true });
  fs.writeFileSync(cursor, '{"editor":{"fontSize":14},"hooks":{"stop":[{"command":"third"}]}}\n');
  assert.equal(manager.install("cursor-agent").ok, true);
  assert.equal(readJson(cursor).hooks.stop.length, 2);
  manager.uninstall("cursor-agent");
  assert.deepEqual(readJson(cursor), { editor: { fontSize: 14 }, hooks: { stop: [{ command: "third" }] } });

  const kimi = path.join(home, ".kimi-code", "config.toml");
  fs.mkdirSync(path.dirname(kimi), { recursive: true });
  fs.writeFileSync(kimi, 'model = "kimi"\n');
  assert.equal(manager.install("kimi-code").ok, true);
  assert.match(fs.readFileSync(kimi, "utf8"), /Vibe Halo integration \(kimi-code\)/);
  manager.uninstall("kimi-code");
  assert.equal(fs.readFileSync(kimi, "utf8").trim(), 'model = "kimi"');
});

test("installs managed plugin assets without exposing runtime secrets in config", () => {
  const { home, manager } = fixture();
  const configPath = path.join(home, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{"plugin":["third-party"]}\n');
  assert.equal(manager.install("opencode").ok, true);
  const config = readJson(configPath);
  assert.equal(config.plugin[0], "third-party");
  assert.equal(config.plugin.some(value => value.includes("vibe-halo")), true);
  assert.equal(JSON.stringify(config).includes("token"), false);
  assert.equal(fs.existsSync(path.join(path.dirname(configPath), "vibe-halo", "index.mjs")), true);
  manager.uninstall("opencode");
  assert.deepEqual(readJson(configPath).plugin, ["third-party"]);
});

test("has an install and safe-uninstall contract for every non-Codex adapter", () => {
  const { home, manager } = fixture();
  const jsonAgents = [
    "zcode", "qwen-code", "copilot-cli", "claude-code", "codebuddy", "gemini-cli",
    "antigravity", "cursor-agent", "qoder", "qoderwork", "reasonix",
  ];
  for (const agentId of jsonAgents) {
    const target = manager.paths(agentId)[0];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"thirdParty":{"keep":true}}\n');
  }
  const kiroDir = manager.paths("kiro")[0];
  fs.mkdirSync(kiroDir, { recursive: true });
  fs.writeFileSync(path.join(kiroDir, "default.json"), '{"name":"default"}\n');
  for (const agentId of ["kimi-code", "codewhale"]) {
    const target = manager.paths(agentId)[0];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'model = "third-party"\n');
  }
  for (const agentId of ["opencode", "openclaw"]) {
    const target = manager.paths(agentId)[0];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, agentId === "opencode" ? '{"plugin":[]}\n' : '{"plugins":{}}\n');
  }
  fs.mkdirSync(manager.paths("pi")[0], { recursive: true });
  fs.mkdirSync(manager.paths("hermes")[0], { recursive: true });

  for (const agentId of [...jsonAgents, "kiro", "kimi-code", "codewhale", "opencode", "pi", "openclaw", "hermes"]) {
    const result = manager.install(agentId);
    if (agentId === "hermes") {
      assert.equal(result.reason, "plugin-copied-cli-enable-required");
      assert.equal(fs.existsSync(path.join(manager.paths(agentId)[0], "vibe-halo", "__init__.py")), true);
    } else {
      assert.equal(result.ok, true, `${agentId}: ${result.reason || "failed"}`);
    }
    assert.equal(manager.uninstall(agentId).ok, true, agentId);
  }
  for (const agentId of jsonAgents) assert.equal(readJson(manager.paths(agentId)[0]).thirdParty.keep, true, agentId);
});
