"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { agent, listAgents } = require("./agent-registry");
const { HookManager } = require("./hook-manager");

const MARKER = "vibe-halo-hook.js";
const GROUP_ID = "vibe-halo";
const EVENTS = Object.freeze({
  zcode: ["PermissionRequest", "Stop", "UserPromptSubmit", "SessionStart"],
  "qwen-code": ["PermissionRequest", "Stop", "UserPromptSubmit"],
  "copilot-cli": ["permissionRequest", "agentStop", "userPromptSubmitted"],
  "claude-code": ["PermissionRequest", "Elicitation", "Stop", "UserPromptSubmit"],
  codebuddy: ["PermissionRequest", "Elicitation", "Stop", "UserPromptSubmit"],
  "gemini-cli": ["AfterAgent", "BeforeAgent"],
  antigravity: ["Stop", "PreInvocation"],
  "cursor-agent": ["stop", "beforeSubmitPrompt"],
  kiro: ["stop", "userPromptSubmit"],
  "kimi-code": ["Stop", "UserPromptSubmit", "PermissionRequest"],
  "qwen-code": ["PermissionRequest", "Stop", "UserPromptSubmit"],
  qoder: ["Stop", "UserPromptSubmit", "PermissionRequest"],
  qoderwork: ["Stop", "UserPromptSubmit", "PermissionRequest"],
  reasonix: ["Stop", "UserPromptSubmit"],
});

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, filePath);
}

function stripJsonComments(text) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const value = JSON.parse(stripJsonComments(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config-root-invalid");
  return value;
}

function safeName(value) {
  return String(value || "config").replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 120);
}

function backupOnce(agentId, filePath, backupRoot) {
  const dir = path.join(backupRoot, agentId);
  const manifestPath = path.join(dir, "manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}
  const resolved = path.resolve(filePath);
  if (manifest[resolved]) return manifest[resolved];
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${Object.keys(manifest).length + 1}-${safeName(path.basename(filePath))}.backup`;
  const backupPath = path.join(dir, fileName);
  const existed = fs.existsSync(filePath);
  if (existed) fs.copyFileSync(filePath, backupPath);
  else atomicWrite(backupPath, "");
  manifest[resolved] = { backupPath, existed, createdAt: new Date().toISOString() };
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest[resolved];
}

function containsMarker(value) {
  if (typeof value === "string") return value.includes(MARKER) || value.includes(GROUP_ID);
  if (Array.isArray(value)) return value.some(containsMarker);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => key === GROUP_ID || containsMarker(item));
}

function removeManaged(value) {
  if (Array.isArray(value)) return value.filter(item => !containsMarker(item)).map(removeManaged);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === GROUP_ID) continue;
    const cleaned = removeManaged(item);
    if (key === "hooks" && cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
      for (const [event, entries] of Object.entries(cleaned)) {
        if (Array.isArray(entries) && entries.length === 0) delete cleaned[event];
      }
    }
    output[key] = cleaned;
  }
  return output;
}

function commandFor(executablePath, scriptPath, agentId, event) {
  const command = processCommandFor(executablePath, scriptPath, agentId, event);
  return `cmd.exe /d /s /c "${command}"`;
}

function processCommandFor(executablePath, scriptPath, agentId, event) {
  const ps = [
    "$env:ELECTRON_RUN_AS_NODE='1'",
    `& '${String(executablePath).replace(/'/g, "''")}' '${String(scriptPath).replace(/'/g, "''")}' --agent '${agentId}' --event '${event}'`,
  ].join("; ");
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return `set VIBE_HALO_HOOK=${MARKER}&&powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function zcodeProcessHook(executablePath, scriptPath, event) {
  return {
    type: "process",
    command: "cmd.exe",
    args: ["/d", "/s", "/c", processCommandFor(executablePath, scriptPath, "zcode", event)],
    timeoutMs: event === "PermissionRequest" ? 135000 : 10000,
  };
}

function isHealthyZcodeProcessHook(value, event) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.type !== "process" || String(value.command).toLowerCase() !== "cmd.exe") return false;
  if (!Array.isArray(value.args) || value.args.length !== 4) return false;
  if (value.args[0] !== "/d" || value.args[1] !== "/s" || value.args[2] !== "/c") return false;
  if (typeof value.args[3] !== "string" || !value.args[3].includes(`VIBE_HALO_HOOK=${MARKER}`)) return false;
  return value.timeoutMs === (event === "PermissionRequest" ? 135000 : 10000);
}

function isHealthyZcodeIntegration(config) {
  if (!config || config.hooks?.enabled !== true) return false;
  const eventMap = config.hooks?.events;
  if (!eventMap || typeof eventMap !== "object" || Array.isArray(eventMap)) return false;
  return EVENTS.zcode.every(event => {
    const entries = eventMap[event];
    return Array.isArray(entries) && entries.some(entry => (
      !entry?.matcher
      && Array.isArray(entry?.hooks)
      && entry.hooks.some(hook => containsMarker(hook) && isHealthyZcodeProcessHook(hook, event))
    ));
  });
}

function nestedEntry(command, event, agentId) {
  const handler = { type: "command", command };
  if (["qwen-code"].includes(agentId)) handler.timeout = event === "PermissionRequest" ? 135000 : 30000;
  else if (["claude-code"].includes(agentId)) handler.timeout = event === "PermissionRequest" ? 135 : 10;
  if (!["claude-code", "codebuddy"].includes(agentId)) handler.name = GROUP_ID;
  return {
    ...(event === "Stop" || event === "UserPromptSubmit" ? {} : { matcher: "*" }),
    hooks: [handler],
  };
}

function explicitDisabled(agentId, config) {
  if (agentId === "zcode") return config.hooks?.enabled === false;
  if (agentId === "qwen-code") return config.disableAllHooks === true || config.hooksConfig?.disabled === true;
  return config.hooksConfig?.disabled === true || config.hooks?.enabled === false;
}

function addJsonHooks(agentId, config, executablePath, scriptPath) {
  const events = EVENTS[agentId] || [];
  if (agentId === "zcode") {
    const existing = config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? config.hooks : {};
    const eventMap = existing.events && typeof existing.events === "object" && !Array.isArray(existing.events) ? existing.events : {};
    for (const event of events) {
      const other = Array.isArray(eventMap[event]) ? eventMap[event].filter(item => !containsMarker(item)) : [];
      other.push({
        hooks: [zcodeProcessHook(executablePath, scriptPath, event)],
      });
      eventMap[event] = other;
    }
    config.hooks = { ...existing, enabled: true, timeoutMs: existing.timeoutMs || 60000, maxOutputBytes: existing.maxOutputBytes || 32768, events: eventMap };
    return config;
  }
  if (agentId === "copilot-cli") {
    if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) config.hooks = {};
    for (const event of events) {
      const entries = Array.isArray(config.hooks[event]) ? config.hooks[event].filter(item => !containsMarker(item)) : [];
      const command = commandFor(executablePath, scriptPath, agentId, event);
      entries.push({ type: "command", bash: command, powershell: command, timeoutSec: event === "permissionRequest" ? 135 : 10 });
      config.hooks[event] = entries;
    }
    return config;
  }
  if (agentId === "antigravity") {
    config[GROUP_ID] = {
      PreInvocation: [{ type: "command", command: commandFor(executablePath, scriptPath, agentId, "PreInvocation"), timeout: 10 }],
      Stop: [{ type: "command", command: commandFor(executablePath, scriptPath, agentId, "Stop"), timeout: 10 }],
    };
    return config;
  }
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) config.hooks = {};
  for (const event of events) {
    const entries = Array.isArray(config.hooks[event]) ? config.hooks[event].filter(item => !containsMarker(item)) : [];
    const command = commandFor(executablePath, scriptPath, agentId, event);
    if (agentId === "cursor-agent" || agentId === "kiro") entries.push({ command });
    else if (agentId === "reasonix") entries.push({ match: "*", command });
    else entries.push(nestedEntry(command, event, agentId));
    config.hooks[event] = entries;
  }
  return config;
}

function managedTomlBlock(agentId, executablePath, scriptPath) {
  const events = agentId === "kimi-code"
    ? ["UserPromptSubmit", "Stop", "PermissionRequest"]
    : ["message_submit", "session_end"];
  const lines = [`# >>> Vibe Halo integration (${agentId}) >>>`];
  for (const event of events) {
    const command = commandFor(executablePath, scriptPath, agentId, event).replace(/'/g, "''");
    if (agentId === "kimi-code") {
      lines.push("[[hooks]]", `event = '${event}'`, "matcher = '*'", `command = '${command}'`, `timeout = ${event === "PermissionRequest" ? 135 : 10}`, "");
    } else {
      lines.push("[[hooks.hooks]]", `# managed by Vibe Halo`, `event = '${event}'`, `command = '''${command}'''`, "background = true", "timeout_secs = 5", "");
    }
  }
  lines.push(`# <<< Vibe Halo integration (${agentId}) <<<`);
  return lines.join("\n");
}

function replaceTomlBlock(text, agentId, block) {
  const start = `# >>> Vibe Halo integration (${agentId}) >>>`;
  const end = `# <<< Vibe Halo integration (${agentId}) <<<`;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  let base = text;
  if (startAt >= 0 && endAt >= 0) base = `${text.slice(0, startAt)}${text.slice(endAt + end.length)}`;
  return `${base.trimEnd()}${base.trim() ? "\n\n" : ""}${block}\n`;
}

function removeTomlBlock(text, agentId) {
  const start = `# >>> Vibe Halo integration (${agentId}) >>>`;
  const end = `# <<< Vibe Halo integration (${agentId}) <<<`;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) return text;
  return `${text.slice(0, startAt)}${text.slice(endAt + end.length)}`.replace(/\n{3,}/g, "\n\n");
}

function pathExists(value) {
  try { return fs.existsSync(value); } catch { return false; }
}

class IntegrationManager {
  constructor(options = {}) {
    this.homeDir = options.homeDir || os.homedir();
    this.appData = options.appData || process.env.APPDATA || path.join(this.homeDir, "AppData", "Roaming");
    this.executablePath = options.executablePath || process.execPath;
    this.hookScriptPath = options.hookScriptPath;
    this.assetRoot = options.assetRoot || path.join(__dirname, "..", "hooks", "integrations");
    this.backupRoot = options.backupRoot || path.join(this.homeDir, ".vibe-halo", "backups", "integrations");
    this.settings = options.settings;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.detectionCache = new Map();
    this.codexManager = options.codexManager || new HookManager({
      executablePath: this.executablePath,
      hookScriptPath: this.hookScriptPath,
      logger: this.logger,
    });
  }

  paths(agentId) {
    const home = this.homeDir;
    const map = {
      zcode: [path.join(home, ".zcode", "cli", "config.json")],
      "qwen-code": [path.join(home, ".qwen", "settings.json")],
      "copilot-cli": [path.join(process.env.COPILOT_HOME || path.join(home, ".copilot"), "hooks", "hooks.json")],
      "claude-code": [path.join(home, ".claude", "settings.json")],
      codebuddy: [path.join(home, ".codebuddy", "settings.json")],
      "gemini-cli": [path.join(home, ".gemini", "settings.json")],
      antigravity: [path.join(home, ".gemini", "config", "hooks.json")],
      "cursor-agent": [path.join(home, ".cursor", "hooks.json")],
      kiro: [path.join(home, ".kiro", "agents")],
      "kimi-code": [path.join(home, ".kimi-code", "config.toml"), path.join(home, ".kimi", "config.toml")],
      codewhale: [path.join(home, ".codewhale", "config.toml")],
      opencode: [path.join(home, ".config", "opencode", "opencode.json"), path.join(home, ".config", "opencode", "opencode.jsonc")],
      pi: [path.join(home, ".pi", "agent", "extensions")],
      openclaw: [path.join(process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"), "openclaw.json")],
      hermes: [path.join(home, ".hermes", "plugins")],
      qoder: [path.join(home, ".qoder", "settings.json")],
      qoderwork: [path.join(home, ".qoderwork", "settings.json")],
      reasonix: [path.join(this.appData, "reasonix", "settings.json")],
    };
    return map[agentId] || [];
  }

  configHomePath(descriptorValue) {
    if (!descriptorValue?.configHome) return null;
    if (descriptorValue.id === "reasonix") return path.join(this.appData, "reasonix");
    return path.join(this.homeDir, ...String(descriptorValue.configHome).split(/[\\/]+/).filter(Boolean));
  }

  executableDetected(descriptorValue) {
    for (const name of descriptorValue.executableNames) {
      try {
        const result = childProcess.spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 1000 });
        if (result.status === 0 && result.stdout.trim()) return true;
      } catch {}
    }
    if (descriptorValue.id === "zcode" && pathExists(path.join(process.env.ProgramFiles || "C:\\Program Files", "ZCode", "ZCode.exe"))) return true;
    if (descriptorValue.id === "cursor-agent" && pathExists(path.join(process.env.LOCALAPPDATA || "", "Programs", "cursor", "Cursor.exe"))) return true;
    return false;
  }

  detect(agentId, options = {}) {
    const cached = this.detectionCache.get(agentId);
    if (!options.force && cached && Date.now() - cached.at < 30_000) return { ...cached.value };
    const descriptorValue = agent(agentId);
    if (!descriptorValue) return { detected: false, reason: "unknown-agent" };
    if (agentId === "codex") {
      const value = { detected: this.codexManager.ensureCodexDir(), reason: "codex-home" };
      this.detectionCache.set(agentId, { at: Date.now(), value });
      return { ...value };
    }
    const executable = this.executableDetected(descriptorValue);
    const configHome = this.configHomePath(descriptorValue);
    const configSignal = (configHome && pathExists(configHome))
      || this.paths(agentId).some(target => pathExists(target) || pathExists(path.dirname(target)));
    const value = { detected: executable || configSignal, executable, reason: executable ? "executable" : (configSignal ? "config" : "not-found") };
    this.detectionCache.set(agentId, { at: Date.now(), value });
    return { ...value };
  }

  installJson(agentId, filePath) {
    const config = readJson(filePath);
    if (explicitDisabled(agentId, config)) return { ok: false, disabled: true, reason: "hooks-explicitly-disabled", path: filePath };
    backupOnce(agentId, filePath, this.backupRoot);
    const cleaned = removeManaged(config);
    const next = addJsonHooks(agentId, cleaned, this.executablePath, this.hookScriptPath);
    const output = `${JSON.stringify(next, null, 2)}\n`;
    const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    if (output !== original) atomicWrite(filePath, output);
    return { ok: true, changed: output !== original, path: filePath };
  }

  installKiro(dirPath) {
    if (!pathExists(dirPath)) return { ok: false, reason: "agent-config-directory-missing", path: dirPath };
    const files = fs.readdirSync(dirPath).filter(name => name.endsWith(".json")).map(name => path.join(dirPath, name));
    if (!files.length) return { ok: false, reason: "agent-config-missing", path: dirPath };
    let changed = false;
    for (const filePath of files) changed = this.installJson("kiro", filePath).changed || changed;
    return { ok: true, changed, path: dirPath };
  }

  installToml(agentId, filePath) {
    const original = pathExists(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    if (agentId === "codewhale" && /^\s*enabled\s*=\s*false\b/m.test((original.match(/\[hooks\][\s\S]*?(?=\n\s*\[|$)/) || [""])[0])) {
      return { ok: false, disabled: true, reason: "hooks-explicitly-disabled", path: filePath };
    }
    backupOnce(agentId, filePath, this.backupRoot);
    let base = original;
    if (agentId === "codewhale" && !/^\s*\[hooks\]\s*$/m.test(base)) base = `${base.trimEnd()}${base.trim() ? "\n\n" : ""}[hooks]\nenabled = true\n`;
    const next = replaceTomlBlock(base, agentId, managedTomlBlock(agentId, this.executablePath, this.hookScriptPath));
    if (next !== original) atomicWrite(filePath, next);
    return { ok: true, changed: next !== original, path: filePath };
  }

  installAsset(agentId) {
    const source = path.join(this.assetRoot, agentId);
    if (!pathExists(source)) return { ok: false, reason: "integration-asset-missing" };
    if (agentId === "opencode") {
      const configPath = this.paths(agentId).find(pathExists) || this.paths(agentId)[0];
      const config = readJson(configPath);
      backupOnce(agentId, configPath, this.backupRoot);
      const target = path.join(path.dirname(configPath), GROUP_ID);
      fs.cpSync(source, target, { recursive: true });
      const plugins = Array.isArray(config.plugin) ? config.plugin.filter(item => typeof item !== "string" || !item.includes(GROUP_ID)) : [];
      plugins.push(target.replace(/\\/g, "/"));
      config.plugin = plugins;
      atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
      return { ok: true, changed: true, path: configPath };
    }
    if (agentId === "pi") {
      const target = path.join(this.paths(agentId)[0], "vibe-halo.js");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, "index.js"), target);
      return { ok: true, changed: true, path: target };
    }
    if (agentId === "openclaw") {
      const configPath = this.paths(agentId)[0];
      const target = path.join(path.dirname(configPath), "extensions", GROUP_ID);
      const config = readJson(configPath);
      if (config.$include !== undefined || config.include !== undefined) return { ok: false, reason: "config-has-include", path: configPath };
      backupOnce(agentId, configPath, this.backupRoot);
      fs.cpSync(source, target, { recursive: true });
      if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
      if (!config.plugins.load || typeof config.plugins.load !== "object") config.plugins.load = {};
      if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
      config.plugins.load.paths = config.plugins.load.paths.filter(item => typeof item !== "string" || !item.includes(GROUP_ID));
      config.plugins.load.paths.push(target.replace(/\\/g, "/"));
      if (!config.plugins.entries || typeof config.plugins.entries !== "object") config.plugins.entries = {};
      config.plugins.entries[GROUP_ID] = { enabled: true, hooks: { allowConversationAccess: false } };
      atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
      return { ok: true, changed: true, path: configPath };
    }
    if (agentId === "hermes") {
      const target = path.join(this.paths(agentId)[0], GROUP_ID);
      fs.cpSync(source, target, { recursive: true });
      let enabled = false;
      try {
        const result = childProcess.spawnSync("hermes", ["plugins", "enable", GROUP_ID], { encoding: "utf8", windowsHide: true, timeout: 10000 });
        enabled = result.status === 0;
      } catch {}
      return { ok: enabled, changed: true, path: target, reason: enabled ? null : "plugin-copied-cli-enable-required" };
    }
    return { ok: false, reason: "unsupported-asset" };
  }

  install(agentId) {
    const descriptorValue = agent(agentId);
    if (!descriptorValue) return { ok: false, reason: "unknown-agent" };
    if (!this.hookScriptPath || !pathExists(this.hookScriptPath)) return { ok: false, reason: "hook-script-missing" };
    if (agentId === "codex") return this.codexManager.install();
    if (["opencode", "pi", "openclaw", "hermes"].includes(agentId)) return this.installAsset(agentId);
    const paths = this.paths(agentId);
    if (agentId === "kiro") return this.installKiro(paths[0]);
    if (agentId === "kimi-code") {
      const targets = paths.filter(target => pathExists(target) || pathExists(path.dirname(target)));
      if (!targets.length) return { ok: false, reason: "config-home-missing" };
      const results = targets.map(target => this.installToml(agentId, target));
      return { ok: results.every(result => result.ok), changed: results.some(result => result.changed), paths: targets };
    }
    if (agentId === "codewhale") return this.installToml(agentId, paths[0]);
    const filePath = paths.find(pathExists) || paths[0];
    if (!filePath || (!pathExists(filePath) && !pathExists(path.dirname(filePath)) && !pathExists(this.configHomePath(descriptorValue)))) {
      return { ok: false, reason: "config-home-missing" };
    }
    return this.installJson(agentId, filePath);
  }

  status(agentId) {
    if (agentId === "codex") {
      const value = this.codexManager.status();
      return { detected: value.codexHomeExists, installed: Object.values(value.events).every(Boolean), healthy: value.healthy, disabled: value.feature === "false", reason: value.feature === "false" ? "hooks-explicitly-disabled" : (value.healthy ? "healthy" : "trust-or-hook-pending") };
    }
    const detection = this.detect(agentId);
    if (!detection.detected) return { ...detection, installed: false, healthy: false, disabled: false };
    if (["opencode", "openclaw"].includes(agentId)) {
      const configPath = this.paths(agentId).find(pathExists);
      let config = {};
      try { config = configPath ? readJson(configPath) : {}; } catch {}
      return { ...detection, installed: containsMarker(config), healthy: containsMarker(config), disabled: false, reason: containsMarker(config) ? "healthy" : "missing" };
    }
    if (agentId === "pi" || agentId === "hermes") {
      const target = agentId === "pi" ? path.join(this.paths(agentId)[0], "vibe-halo.js") : path.join(this.paths(agentId)[0], GROUP_ID);
      return { ...detection, installed: pathExists(target), healthy: pathExists(target), disabled: false, reason: pathExists(target) ? "healthy" : "missing" };
    }
    const target = this.paths(agentId).find(pathExists);
    if (!target) return { ...detection, installed: false, healthy: false, disabled: false, reason: "missing" };
    if (target.endsWith(".toml")) {
      const installed = fs.readFileSync(target, "utf8").includes(`Vibe Halo integration (${agentId})`);
      return { ...detection, installed, healthy: installed, disabled: false, reason: installed ? "healthy" : "missing" };
    }
    if (fs.statSync(target).isDirectory()) {
      const installed = fs.readdirSync(target).filter(name => name.endsWith(".json")).some(name => containsMarker(readJson(path.join(target, name))));
      return { ...detection, installed, healthy: installed, disabled: false, reason: installed ? "healthy" : "missing" };
    }
    try {
      const config = readJson(target);
      const disabled = explicitDisabled(agentId, config);
      const installed = containsMarker(config);
      const healthy = installed && !disabled && (agentId !== "zcode" || isHealthyZcodeIntegration(config));
      const reason = disabled
        ? "hooks-explicitly-disabled"
        : (!installed ? "missing" : (healthy ? "healthy" : "invalid-zcode-process-hook"));
      return { ...detection, installed, healthy, disabled, reason };
    } catch (error) {
      return { ...detection, installed: false, healthy: false, disabled: false, reason: error.message };
    }
  }

  updateSetting(agentId, status, reason = status.reason) {
    if (!this.settings?.setIntegration) return;
    const current = this.settings.getIntegration(agentId);
    this.settings.setIntegration(agentId, {
      detected: status.detected === true,
      installed: status.installed === true,
      healthy: status.healthy === true,
      disabledByUser: current.disabledByUser,
      verification: current.verification === "live" ? "live" : (status.installed ? "contract" : "none"),
      reason: String(reason || "").slice(0, 240),
      checkedAt: Date.now(),
    });
  }

  scan(options = {}) {
    this.detectionCache.clear();
    const installDetected = options.install !== false;
    const results = [];
    for (const descriptorValue of listAgents()) {
      const current = this.settings?.getIntegration ? this.settings.getIntegration(descriptorValue.id) : { disabledByUser: false };
      const detection = this.detect(descriptorValue.id);
      let installResult = null;
      if (installDetected && detection.detected && !current.disabledByUser) {
        try { installResult = this.install(descriptorValue.id); }
        catch (error) { installResult = { ok: false, reason: error.message }; }
      }
      const status = this.status(descriptorValue.id);
      this.updateSetting(descriptorValue.id, status, installResult?.reason || status.reason);
      results.push({ agent: descriptorValue, ...status, installResult, disabledByUser: current.disabledByUser });
    }
    return results;
  }

  enable(agentId) {
    this.settings?.setIntegration?.(agentId, { disabledByUser: false });
    const result = this.install(agentId);
    this.updateSetting(agentId, this.status(agentId), result.reason);
    return result;
  }

  disable(agentId) {
    const result = this.uninstall(agentId);
    this.settings?.setIntegration?.(agentId, { disabledByUser: true, installed: false, healthy: false, reason: "disabled-by-user", checkedAt: Date.now() });
    return result;
  }

  uninstall(agentId) {
    if (agentId === "codex") return this.codexManager.uninstall();
    if (["opencode", "openclaw"].includes(agentId)) {
      const configPath = this.paths(agentId).find(pathExists);
      if (configPath) atomicWrite(configPath, `${JSON.stringify(removeManaged(readJson(configPath)), null, 2)}\n`);
      const target = agentId === "opencode"
        ? (configPath ? path.join(path.dirname(configPath), GROUP_ID) : null)
        : path.join(path.dirname(this.paths(agentId)[0]), "extensions", GROUP_ID);
      if (target && pathExists(target)) fs.rmSync(target, { recursive: true });
      return { ok: true };
    }
    if (agentId === "pi") {
      const target = path.join(this.paths(agentId)[0], "vibe-halo.js");
      if (pathExists(target)) fs.unlinkSync(target);
      return { ok: true };
    }
    if (agentId === "hermes") {
      const target = path.join(this.paths(agentId)[0], GROUP_ID);
      try { childProcess.spawnSync("hermes", ["plugins", "disable", GROUP_ID], { encoding: "utf8", windowsHide: true, timeout: 10000 }); } catch {}
      if (pathExists(target)) fs.rmSync(target, { recursive: true });
      return { ok: true };
    }
    for (const target of this.paths(agentId)) {
      if (!pathExists(target)) continue;
      if (target.endsWith(".toml")) {
        const original = fs.readFileSync(target, "utf8");
        const next = removeTomlBlock(original, agentId);
        if (next !== original) atomicWrite(target, next);
      } else if (fs.statSync(target).isDirectory()) {
        for (const name of fs.readdirSync(target).filter(name => name.endsWith(".json"))) {
          const filePath = path.join(target, name);
          atomicWrite(filePath, `${JSON.stringify(removeManaged(readJson(filePath)), null, 2)}\n`);
        }
      } else {
        atomicWrite(target, `${JSON.stringify(removeManaged(readJson(target)), null, 2)}\n`);
      }
    }
    return { ok: true };
  }

  repairAll() {
    return this.scan({ install: true });
  }

  uninstallAll() {
    return listAgents().map(descriptorValue => ({ agentId: descriptorValue.id, result: this.uninstall(descriptorValue.id) }));
  }
}

module.exports = {
  IntegrationManager,
  MARKER,
  EVENTS,
  addJsonHooks,
  atomicWrite,
  backupOnce,
  commandFor,
  containsMarker,
  explicitDisabled,
  isHealthyZcodeIntegration,
  isHealthyZcodeProcessHook,
  processCommandFor,
  readJson,
  removeManaged,
  removeTomlBlock,
  replaceTomlBlock,
  stripJsonComments,
  zcodeProcessHook,
};
