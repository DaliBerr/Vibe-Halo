"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  BACKUP_DIR,
  EVENT_TIMEOUT_SECONDS,
  HOOK_TIMEOUT_SECONDS,
  LEGACY_EVENTS,
  LEGACY_HOOK_MARKER,
  MANAGED_EVENTS,
  MIGRATION_PATH,
  OWN_HOOK_MARKER,
  PREVIOUS_HOOK_MARKER,
} = require("./constants");

function defaultPaths() {
  const codexDir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    codexDir,
    hooksPath: path.join(codexDir, "hooks.json"),
    configPath: path.join(codexDir, "config.toml"),
    migrationPath: MIGRATION_PATH,
    backupDir: BACKUP_DIR,
  };
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, filePath);
}

function commandContains(hook, marker) {
  return !!hook && [hook.command, hook.commandWindows].some(value => typeof value === "string" && value.includes(marker));
}

function removeMarkerEntries(settings, marker, events) {
  const removed = [];
  let count = 0;
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  for (const event of events) {
    const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const nextEntries = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        nextEntries.push(entry);
        continue;
      }
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      const keep = [];
      for (const hook of hooks) {
        if (commandContains(hook, marker)) {
          count++;
          removed.push({ event, entry: { ...entry, hooks: [{ ...hook }] } });
        } else {
          keep.push(hook);
        }
      }
      if (keep.length) nextEntries.push({ ...entry, hooks: keep });
    }
    if (nextEntries.length) settings.hooks[event] = nextEntries;
    else delete settings.hooks[event];
  }
  return { count, removed };
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildHookCommand(executablePath, hookScriptPath, args = []) {
  // Electron executables are Windows GUI-subsystem programs. PowerShell's
  // call operator returns immediately for them, dropping the blocking hook's
  // stdin/stdout contract. cmd.exe /c acts as the console parent, waits for
  // ELECTRON_RUN_AS_NODE to finish, and forwards both streams back to Codex.
  const tail = Array.isArray(args) ? args.map(cmdQuote).join(" ") : "";
  const childCommand = `${cmdQuote(executablePath)} ${cmdQuote(hookScriptPath)}${tail ? ` ${tail}` : ""}`;
  return `$env:ELECTRON_RUN_AS_NODE='1'; cmd.exe /d /s /c ${psSingleQuote(childCommand)}`;
}

function desiredHook(event, executablePath, hookScriptPath) {
  const command = buildHookCommand(executablePath, hookScriptPath);
  return {
    hooks: [{
      type: "command",
      command,
      commandWindows: command,
      timeout: event === "PermissionRequest" ? HOOK_TIMEOUT_SECONDS : EVENT_TIMEOUT_SECONDS,
    }],
  };
}

function featureState(configText) {
  if (typeof configText !== "string" || !configText.trim()) return "unset";
  let section = "";
  for (const line of configText.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section !== "features") continue;
    const match = line.match(/^\s*(hooks|codex_hooks)\s*=\s*(true|false)\b/i);
    if (match) return match[2].toLowerCase();
  }
  return "unset";
}

function eventStateName(event) {
  return String(event)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function parseTomlString(value) {
  const text = String(value || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return null; }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return null;
}

function parseHookTrustStates(configText) {
  const states = new Map();
  if (typeof configText !== "string") return states;
  let current = null;
  for (const line of configText.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[hooks\.state\.(.+)\]\s*(?:#.*)?$/i);
    if (sectionMatch) {
      const id = parseTomlString(sectionMatch[1]);
      current = id ? { id, enabled: true, trustedHash: "" } : null;
      if (current) states.set(id.toLowerCase(), current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\b/i);
    if (enabled) current.enabled = enabled[1].toLowerCase() === "true";
    const trusted = line.match(/^\s*trusted_hash\s*=\s*(["'][^"']+["'])/i);
    if (trusted) current.trustedHash = parseTomlString(trusted[1]) || "";
  }
  return states;
}

function hookTrustStatus(settings, configText, hooksPath) {
  const states = parseHookTrustStates(configText);
  const events = {};
  for (const event of MANAGED_EVENTS) {
    const entries = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
    const ownHandlers = [];
    entries.forEach((entry, groupIndex) => {
      const handlers = Array.isArray(entry?.hooks) ? entry.hooks : [];
      handlers.forEach((handler, handlerIndex) => {
        if (commandContains(handler, OWN_HOOK_MARKER)) ownHandlers.push({ groupIndex, handlerIndex });
      });
    });
    if (!ownHandlers.length) {
      events[event] = "missing";
      continue;
    }
    const handlerStates = ownHandlers.map(({ groupIndex, handlerIndex }) => {
      const id = `${path.resolve(hooksPath)}:${eventStateName(event)}:${groupIndex}:${handlerIndex}`.toLowerCase();
      const state = states.get(id);
      if (!state?.trustedHash) return "pending";
      return state.enabled ? "trusted" : "disabled";
    });
    events[event] = handlerStates.every(value => value === "trusted")
      ? "trusted"
      : handlerStates.includes("disabled") ? "disabled" : "pending";
  }
  return {
    events,
    healthy: Object.values(events).every(value => value === "trusted"),
    pendingCount: Object.values(events).filter(value => value === "pending").length,
  };
}

function enableHooksFeature(configText) {
  const text = typeof configText === "string" ? configText : "";
  const lines = text.split(/\r?\n/);
  let section = "";
  let featuresIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      if (section === "features") featuresIndex = i;
      continue;
    }
    if (section === "features" && /^\s*(hooks|codex_hooks)\s*=/.test(lines[i])) {
      lines[i] = "hooks = true";
      return `${lines.join("\n").replace(/\n+$/, "")}\n`;
    }
  }
  if (featuresIndex >= 0) {
    lines.splice(featuresIndex + 1, 0, "hooks = true");
    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
  }
  const prefix = text.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}[features]\nhooks = true\n`;
}

function legacyTargetExists(record, exists = fs.existsSync) {
  const hooks = record?.entry?.hooks;
  if (!Array.isArray(hooks)) return false;
  for (const hook of hooks) {
    for (const command of [hook?.commandWindows, hook?.command]) {
      if (typeof command !== "string") continue;
      const quoted = [...command.matchAll(/["']([^"']*codex-hook\.js)["']/gi)].map(match => match[1]);
      const plain = command.match(/(?:^|\s)([^\s"']*codex-hook\.js)(?:\s|$)/i);
      if (plain) quoted.push(plain[1]);
      if (quoted.some(candidate => exists(candidate.replace(/^\/mnt\/([a-z])\//i, (_, drive) => `${drive}:\\`).replace(/\//g, path.sep)))) {
        return true;
      }
    }
  }
  return false;
}

class HookManager {
  constructor(options = {}) {
    const paths = { ...defaultPaths(), ...(options.paths || {}) };
    Object.assign(this, paths);
    this.executablePath = options.executablePath || process.execPath;
    this.hookScriptPath = options.hookScriptPath;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
  }

  ensureCodexDir() {
    return fs.existsSync(this.codexDir);
  }

  install() {
    if (!this.ensureCodexDir()) return { ok: false, reason: "codex-home-missing", feature: "unset" };
    if (!this.hookScriptPath || !fs.existsSync(this.hookScriptPath)) {
      return { ok: false, reason: "hook-script-missing", feature: this.getFeatureState() };
    }
    const originalText = fs.existsSync(this.hooksPath) ? fs.readFileSync(this.hooksPath, "utf8") : "{}\n";
    const settings = readJson(this.hooksPath, {});
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { ok: false, reason: "hooks-json-invalid", feature: this.getFeatureState() };
    }

    let migration = readJson(this.migrationPath, null);
    let migrated = 0;
    if (!migration) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.join(this.backupDir, `hooks-${stamp}.json`);
      atomicWrite(backupPath, originalText);
      const legacy = removeMarkerEntries(settings, LEGACY_HOOK_MARKER, LEGACY_EVENTS);
      migrated = legacy.count;
      migration = { version: 1, createdAt: new Date().toISOString(), backupPath, removed: legacy.removed };
      atomicWrite(this.migrationPath, `${JSON.stringify(migration, null, 2)}\n`);
    }

    removeMarkerEntries(settings, PREVIOUS_HOOK_MARKER, LEGACY_EVENTS);
    removeMarkerEntries(settings, OWN_HOOK_MARKER, LEGACY_EVENTS);
    if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
    for (const event of MANAGED_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      settings.hooks[event].push(desiredHook(event, this.executablePath, this.hookScriptPath));
    }
    const nextText = `${JSON.stringify(settings, null, 2)}\n`;
    if (nextText !== originalText) atomicWrite(this.hooksPath, nextText);
    const result = { ok: true, reason: null, feature: this.getFeatureState(), migrated, changed: nextText !== originalText };
    this.logger.info("Codex Hook installed", { migrated, feature: result.feature });
    return result;
  }

  uninstall(options = {}) {
    const settings = readJson(this.hooksPath, {});
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { ok: false, reason: "hooks-json-invalid" };
    const removedOwn = removeMarkerEntries(settings, OWN_HOOK_MARKER, LEGACY_EVENTS).count
      + removeMarkerEntries(settings, PREVIOUS_HOOK_MARKER, LEGACY_EVENTS).count;
    const migration = readJson(this.migrationPath, null);
    let restored = 0;
    if (migration && Array.isArray(migration.removed)) {
      for (const record of migration.removed) {
        if (!LEGACY_EVENTS.includes(record.event) || !legacyTargetExists(record, options.exists || fs.existsSync)) continue;
        if (!settings.hooks) settings.hooks = {};
        if (!Array.isArray(settings.hooks[record.event])) settings.hooks[record.event] = [];
        const alreadyThere = settings.hooks[record.event].some(entry => (entry.hooks || []).some(hook => commandContains(hook, LEGACY_HOOK_MARKER)));
        if (!alreadyThere) {
          settings.hooks[record.event].push(record.entry);
          restored++;
        }
      }
    }
    atomicWrite(this.hooksPath, `${JSON.stringify(settings, null, 2)}\n`);
    this.logger.info("Codex Hook uninstalled", { removedOwn, restored });
    return { ok: true, removedOwn, restored };
  }

  getFeatureState() {
    try { return featureState(fs.readFileSync(this.configPath, "utf8")); }
    catch { return "unset"; }
  }

  enableFeature() {
    let text = "";
    try { text = fs.readFileSync(this.configPath, "utf8"); } catch {}
    atomicWrite(this.configPath, enableHooksFeature(text));
    return this.getFeatureState() === "true";
  }

  status() {
    const settings = readJson(this.hooksPath, {});
    let configText = "";
    try { configText = fs.readFileSync(this.configPath, "utf8"); } catch {}
    const eventStatus = {};
    for (const event of MANAGED_EVENTS) {
      const entries = settings?.hooks?.[event];
      eventStatus[event] = Array.isArray(entries)
        && entries.some(entry => (entry?.hooks || []).some(hook => commandContains(hook, OWN_HOOK_MARKER)));
    }
    const trust = hookTrustStatus(settings, configText, this.hooksPath);
    return {
      codexHomeExists: this.ensureCodexDir(),
      feature: featureState(configText),
      events: eventStatus,
      trust,
      healthy: this.ensureCodexDir()
        && featureState(configText) !== "false"
        && Object.values(eventStatus).every(Boolean)
        && trust.healthy,
    };
  }
}

module.exports = {
  HookManager,
  buildHookCommand,
  commandContains,
  enableHooksFeature,
  eventStateName,
  featureState,
  hookTrustStatus,
  legacyTargetExists,
  parseHookTrustStates,
  removeMarkerEntries,
};
