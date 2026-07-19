"use strict";

const { execFile } = require("child_process");

let nativeLocator;

function normalizeBounds(value) {
  if (!value || typeof value !== "object") return null;
  const bounds = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
  return Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0 ? bounds : null;
}

function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function pointInside(point, bounds) {
  return point && point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

function chooseDisplay(displays, windowBounds, cursorPoint, primaryDisplay) {
  const list = Array.isArray(displays) ? displays.filter(item => item && normalizeBounds(item.bounds)) : [];
  const target = normalizeBounds(windowBounds);
  if (target && list.length) {
    let best = null;
    let bestArea = 0;
    for (const display of list) {
      const area = intersectionArea(target, display.bounds);
      if (area > bestArea) {
        best = display;
        bestArea = area;
      }
    }
    if (best) return best;
  }
  const cursorDisplay = list.find(display => pointInside(cursorPoint, display.bounds));
  return cursorDisplay || primaryDisplay || list[0] || null;
}

function createNativeLocator(options = {}) {
  if (process.platform !== "win32" && !options.force) return null;
  try {
    const koffi = options.koffi || require("koffi");
    const user32 = koffi.load("user32.dll");
  try { koffi.struct("VibeHaloRECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" }); } catch {}
    let callbackType;
  try { callbackType = koffi.proto("bool __stdcall VibeHaloEnumProc(void* hwnd, intptr_t lParam)"); }
  catch { callbackType = "VibeHaloEnumProc"; }
  const EnumWindows = user32.func("bool __stdcall EnumWindows(VibeHaloEnumProc *cb, intptr_t lParam)");
    const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void* hwnd)");
    const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint32* pid)");
  const GetWindowRect = user32.func("bool __stdcall GetWindowRect(void* hwnd, _Out_ VibeHaloRECT* rect)");
    void callbackType;
    return function findBounds(pidChain) {
      const targets = new Set(pidChain);
      let best = null;
      let bestArea = 0;
      EnumWindows(hwnd => {
        try {
          if (!IsWindowVisible(hwnd)) return true;
          const pidOut = [0];
          GetWindowThreadProcessId(hwnd, pidOut);
          if (!targets.has(pidOut[0])) return true;
          const rect = {};
          if (!GetWindowRect(hwnd, rect)) return true;
          const width = rect.right - rect.left;
          const height = rect.bottom - rect.top;
          const area = width * height;
          if (width >= 100 && height >= 80 && area > bestArea) {
            best = { x: rect.left, y: rect.top, width, height };
            bestArea = area;
          }
        } catch {}
        return true;
      }, 0);
      return best;
    };
  } catch {
    return null;
  }
}

function locateWindowBounds(pidChain, options = {}) {
  const pids = [...new Set((Array.isArray(pidChain) ? pidChain : []).map(Number).filter(pid => Number.isInteger(pid) && pid > 0))].slice(0, 32);
  const platform = options.platform || process.platform;
  if (!pids.length) return Promise.resolve(null);
  if (platform === "linux") return locateLinuxWindowBounds(pids, options);
  if (platform !== "win32") return Promise.resolve(null);
  if (nativeLocator === undefined) nativeLocator = createNativeLocator(options);
  if (nativeLocator) {
    try {
      const nativeBounds = nativeLocator(pids);
      if (nativeBounds) return Promise.resolve(nativeBounds);
    } catch {}
  }
  const timeout = options.timeoutMs || 400;
  const script = [
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class IslandRect {",
    "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);",
    "}",
    "'@",
    `$ids = @(${pids.join(",")})`,
    "$items = @()",
    "foreach ($idValue in $ids) {",
    "  $p = Get-Process -Id $idValue -ErrorAction SilentlyContinue",
    "  if (-not $p -or $p.MainWindowHandle -eq 0) { continue }",
    "  $r = New-Object IslandRect+RECT",
    "  if ([IslandRect]::GetWindowRect($p.MainWindowHandle, [ref]$r)) {",
    "    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top",
    "    if ($w -gt 0 -and $h -gt 0) { $items += [pscustomobject]@{ x=$r.Left; y=$r.Top; width=$w; height=$h; area=($w*$h) } }",
    "  }",
    "}",
    "$items | Sort-Object area -Descending | Select-Object -First 1 | ConvertTo-Json -Compress",
  ].join("\n");
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024,
    }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve(null);
      try { resolve(normalizeBounds(JSON.parse(stdout.trim()))); }
      catch { resolve(null); }
    });
  });
}

function runFile(command, args, options = {}) {
  const runner = options.execFile || execFile;
  return new Promise(resolve => {
    runner(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs || 400,
      windowsHide: true,
      maxBuffer: 32 * 1024,
    }, (error, stdout) => resolve(error ? "" : String(stdout || "")));
  });
}

async function locateLinuxWindowBounds(pidChain, options = {}) {
  if (!(options.env || process.env).DISPLAY) return null;
  const root = await runFile("xprop", ["-root", "_NET_ACTIVE_WINDOW"], options);
  const id = root.match(/0x[0-9a-f]+/i)?.[0];
  if (!id || /^0x0+$/i.test(id)) return null;
  const pidText = await runFile("xprop", ["-id", id, "_NET_WM_PID"], options);
  const windowPid = Number(pidText.match(/=\s*(\d+)/)?.[1]);
  if (!Number.isInteger(windowPid) || !pidChain.includes(windowPid)) return null;
  const info = await runFile("xwininfo", ["-id", id], options);
  const x = Number(info.match(/Absolute upper-left X:\s*(-?\d+)/i)?.[1]);
  const y = Number(info.match(/Absolute upper-left Y:\s*(-?\d+)/i)?.[1]);
  const width = Number(info.match(/Width:\s*(\d+)/i)?.[1]);
  const height = Number(info.match(/Height:\s*(\d+)/i)?.[1]);
  return normalizeBounds({ x, y, width, height });
}

async function locateDisplay(screenApi, entry, options = {}) {
  const chain = [entry?.sourcePid, ...(entry?.pidChain || [])];
  const windowBounds = await (options.locateWindowBounds || locateWindowBounds)(chain, options);
  const displays = screenApi.getAllDisplays();
  return chooseDisplay(displays, windowBounds, screenApi.getCursorScreenPoint(), screenApi.getPrimaryDisplay());
}

module.exports = {
  chooseDisplay,
  createNativeLocator,
  intersectionArea,
  locateDisplay,
  locateLinuxWindowBounds,
  locateWindowBounds,
  normalizeBounds,
  pointInside,
  runFile,
};
