"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);

function normalizePlatform(value = process.platform) {
  return SUPPORTED_PLATFORMS.has(value) ? value : "linux";
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function desktopExecQuote(value) {
  return `"${String(value).replace(/(["`\\$])/g, "\\$1")}"`;
}

function atomicWrite(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { encoding: "utf8", ...(mode ? { mode } : {}) });
  fs.renameSync(temp, filePath);
  if (mode && process.platform !== "win32") fs.chmodSync(filePath, mode);
}

function selectLinuxWindowBackend(env = process.env) {
  const wayland = String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" || Boolean(env.WAYLAND_DISPLAY);
  if (!wayland) return "x11";
  if (env.VIBE_HALO_NATIVE_WAYLAND === "1") return "wayland-degraded";
  return env.DISPLAY ? "xwayland" : "wayland-degraded";
}

function packageKind(platform, env = process.env, packaged = false) {
  if (!packaged) return "source";
  if (platform === "win32") return "nsis";
  if (platform === "darwin") return "dmg-or-zip";
  return env.APPIMAGE ? "appimage" : "deb";
}

function buildPosixRunner(runtimePath, hookScriptPath) {
  return [
    "#!/bin/sh",
    "unset ELECTRON_NO_ASAR",
    "export ELECTRON_RUN_AS_NODE=1",
    `exec ${posixQuote(runtimePath)} ${posixQuote(hookScriptPath)} "$@"`,
    "",
  ].join("\n");
}

function buildDesktopEntry(executablePath) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Vibe Halo",
    "Comment=Approval and notification island for AI coding agents",
    `Exec=${desktopExecQuote(executablePath)}`,
    "Terminal=false",
    "Categories=Utility;Development;",
    "StartupNotify=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

class PlatformAdapter {
  constructor(options = {}) {
    this.platform = normalizePlatform(options.platform);
    this.arch = options.arch || process.arch;
    this.env = options.env || process.env;
    this.homeDir = options.homeDir || os.homedir();
    this.appData = options.appData || (this.platform === "win32"
      ? (this.env.APPDATA || path.join(this.homeDir, "AppData", "Roaming"))
      : this.platform === "darwin"
        ? path.join(this.homeDir, "Library", "Application Support")
        : (this.env.XDG_CONFIG_HOME || path.join(this.homeDir, ".config")));
    this.executablePath = options.executablePath || process.execPath;
    this.hookRuntimeExecutable = this.platform === "linux" && this.env.APPIMAGE
      ? this.env.APPIMAGE
      : this.executablePath;
    this.packaged = options.packaged === true;
    this.spawnSync = options.spawnSync || childProcess.spawnSync;
    this.runtimeRoot = options.runtimeRoot || path.join(this.homeDir, ".vibe-halo");
    this.windowBackend = this.platform === "linux" ? selectLinuxWindowBackend(this.env) : (this.platform === "win32" ? "win32-native" : "cursor-display");
    this.packageKind = packageKind(this.platform, this.env, this.packaged);
    this.runnerPath = this.platform === "win32" ? null : path.join(this.runtimeRoot, "bin", "vibe-halo-hook-runner");
    this.managedHookPath = this.platform === "win32" ? null : path.join(this.runtimeRoot, "hooks", "vibe-halo-hook.js");
  }

  configureEarly(app) {
    if (this.platform === "linux" && this.windowBackend === "xwayland") {
      app.commandLine.appendSwitch("ozone-platform", "x11");
    } else if (this.platform === "linux" && this.windowBackend === "wayland-degraded") {
      app.commandLine.appendSwitch("ozone-platform", "wayland");
    }
  }

  configureReady(app) {
    if (this.platform === "darwin") {
      try { app.setActivationPolicy("accessory"); } catch {}
    }
  }

  configureWindow(win) {
    if (this.platform !== "darwin") return;
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch {}
    try { win.setHiddenInMissionControl(true); } catch {}
  }

  configureTrayImage(image) {
    if (this.platform === "darwin") {
      try { image.setTemplateImage(true); } catch {}
    }
    return image;
  }

  showNotification(options = {}) {
    if (this.platform === "win32" && options.tray) {
      try {
        options.tray.displayBalloon({ title: options.title, content: options.body });
        return true;
      } catch {}
    }
    const NotificationClass = options.Notification;
    try {
      if (NotificationClass?.isSupported?.()) {
        new NotificationClass({ title: options.title, body: options.body }).show();
        return true;
      }
    } catch {}
    return false;
  }

  prepareHookRuntime(sourceHookPath) {
    if (this.platform === "win32") {
      return { hookScriptPath: sourceHookPath, runnerPath: null };
    }
    if (!sourceHookPath || !fs.existsSync(sourceHookPath)) throw new Error("hook-script-missing");
    const hookBody = fs.readFileSync(sourceHookPath, "utf8");
    atomicWrite(this.managedHookPath, hookBody, 0o600);
    atomicWrite(this.runnerPath, buildPosixRunner(this.hookRuntimeExecutable, this.managedHookPath), 0o700);
    return { hookScriptPath: this.managedHookPath, runnerPath: this.runnerPath };
  }

  removeHookRuntime() {
    if (this.platform === "win32") return false;
    let changed = false;
    for (const target of [this.runnerPath, this.managedHookPath]) {
      try { fs.unlinkSync(target); changed = true; } catch {}
    }
    for (const dir of [path.dirname(this.runnerPath), path.dirname(this.managedHookPath)]) {
      try { fs.rmdirSync(dir); } catch {}
    }
    return changed;
  }

  hookCommand(agentId, event) {
    if (this.platform === "win32" || !this.runnerPath) return null;
    return `${posixQuote(this.runnerPath)} --agent ${posixQuote(agentId)} --event ${posixQuote(event)}`;
  }

  processHook(agentId, event, timeoutMs) {
    if (this.platform === "win32" || !this.runnerPath) return null;
    return {
      type: "process",
      command: this.runnerPath,
      args: ["--agent", agentId, "--event", event],
      timeoutMs,
    };
  }

  executableDetected(descriptor) {
    const names = descriptor?.executableNames || [];
    if (this.platform === "win32") {
      for (const name of names) {
        try {
          const result = this.spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 1000 });
          if (result.status === 0 && String(result.stdout || "").trim()) return true;
        } catch {}
      }
    } else {
      for (const name of names.filter(value => !String(value).toLowerCase().endsWith(".exe"))) {
        if (!/^[A-Za-z0-9._+-]+$/.test(name)) continue;
        for (const shell of [this.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(Boolean)) {
          try {
            const result = this.spawnSync(shell, ["-lc", `command -v -- ${posixQuote(name)}`], { encoding: "utf8", timeout: 1500 });
            if (result.status === 0 && String(result.stdout || "").trim().startsWith("/")) return true;
          } catch {}
        }
      }
    }
    for (const candidate of this.applicationCandidates(descriptor)) {
      try { if (fs.existsSync(candidate)) return true; } catch {}
    }
    return false;
  }

  applicationCandidates(descriptor) {
    const agentId = typeof descriptor === "string" ? descriptor : descriptor?.id;
    const declared = typeof descriptor === "object" && Array.isArray(descriptor?.applicationPaths?.[this.platform])
      ? descriptor.applicationPaths[this.platform].map(value => String(value)
        .replace(/^~(?=[/\\])/, this.homeDir)
        .replace(/%ProgramFiles%/gi, this.env.ProgramFiles || "C:\\Program Files")
        .replace(/%LOCALAPPDATA%/gi, this.env.LOCALAPPDATA || ""))
      : [];
    if (declared.length) return declared.map(value => path.normalize(value));
    if (this.platform === "win32") {
      if (agentId === "zcode") return [path.join(this.env.ProgramFiles || "C:\\Program Files", "ZCode", "ZCode.exe")];
      if (agentId === "cursor-agent") return [path.join(this.env.LOCALAPPDATA || "", "Programs", "cursor", "Cursor.exe")];
      return [];
    }
    if (this.platform === "darwin") {
      const roots = ["/Applications", path.join(this.homeDir, "Applications")];
      const apps = agentId === "zcode" ? ["ZCode.app"] : agentId === "cursor-agent" ? ["Cursor.app"] : [];
      return roots.flatMap(root => apps.map(name => path.join(root, name)));
    }
    const names = agentId === "zcode" ? ["zcode", "ZCode"] : agentId === "cursor-agent" ? ["cursor", "cursor-agent"] : [];
    return names.flatMap(name => [path.join("/usr/bin", name), path.join("/usr/local/bin", name), path.join(this.homeDir, ".local", "bin", name)]);
  }

  setLoginItem(app, enabled) {
    if (this.platform === "linux") {
      const target = path.join(this.env.XDG_CONFIG_HOME || path.join(this.homeDir, ".config"), "autostart", "com.vibe.halo.desktop");
      if (!enabled) {
        try { fs.unlinkSync(target); } catch {}
        return true;
      }
      const executable = this.env.APPIMAGE || this.executablePath;
      atomicWrite(target, buildDesktopEntry(executable), 0o600);
      return true;
    }
    app.setLoginItemSettings({ openAtLogin: !!enabled, ...(this.platform === "win32" ? { path: this.executablePath } : {}) });
    return true;
  }

  status() {
    return {
      platform: this.platform,
      arch: this.arch,
      packageKind: this.packageKind,
      windowBackend: this.windowBackend,
      notificationBackend: this.platform === "win32" ? "tray-balloon" : "system-notification",
      degradedReason: this.windowBackend === "wayland-degraded" ? "native-wayland-window-control-limited" : "",
    };
  }
}

function createPlatformAdapter(options = {}) {
  return new PlatformAdapter(options);
}

module.exports = {
  PlatformAdapter,
  atomicWrite,
  buildDesktopEntry,
  buildPosixRunner,
  createPlatformAdapter,
  desktopExecQuote,
  normalizePlatform,
  packageKind,
  posixQuote,
  selectLinuxWindowBackend,
};
