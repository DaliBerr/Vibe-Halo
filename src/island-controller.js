"use strict";

const path = require("path");
const { formatApprovalInput } = require("./approval-presenter");
const { createLocalizer } = require("./i18n");
const { locateDisplay } = require("./window-locator");

const SHADOW_GUTTER = Object.freeze({ top: 8, right: 24, bottom: 28, left: 24 });
const BOUNDS_ANIMATION_MS = 220;
const BOUNDS_FRAME_MS = 16;
const COMPACT_CONTENT = Object.freeze({ width: 300, height: 52 });
const COMPACT = Object.freeze({
  width: COMPACT_CONTENT.width + SHADOW_GUTTER.left + SHADOW_GUTTER.right,
  height: COMPACT_CONTENT.height + SHADOW_GUTTER.top + SHADOW_GUTTER.bottom,
});
const EXPANDED = Object.freeze({
  width: 668,
  height: 516,
  minWidth: 608,
  maxWidth: 808,
  minHeight: 356,
  maxHeight: 636,
});

function validAnswersPayload(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 10) return false;
  return entries.every(([key, answer]) => {
    if (typeof key !== "string" || !key || key.length > 120) return false;
    const values = Array.isArray(answer) ? answer : [answer];
    return values.length > 0 && values.length <= 20
      && values.every(item => typeof item === "string" && item.length > 0 && item.length <= 2000);
  });
}

function validDecisionPayload(payload, current) {
  const currentId = typeof current === "string" ? current : current?.id;
  const optionId = payload?.optionId || payload?.behavior;
  if (!payload || typeof payload !== "object"
    || typeof payload.approvalId !== "string"
    || payload.approvalId !== currentId
    || typeof optionId !== "string"
    || optionId.length < 1
    || optionId.length > 80
    || !validAnswersPayload(payload.answers)) return false;
  if (typeof current === "string") return optionId === "allow" || optionId === "deny";
  return Array.isArray(current?.options) && current.options.some(option => option?.id === optionId);
}

function validCopyPayload(payload) {
  return !!payload && typeof payload === "object"
    && typeof payload.text === "string"
    && payload.text.length <= 10_000;
}

function validViewPayload(payload, currentId, expanded) {
  if (!payload || typeof payload !== "object" || typeof payload.id !== "string" || payload.id !== currentId) return false;
  if (payload.action === "expand" || payload.action === "collapse") return true;
  return payload.action === "measure"
    && expanded === true
    && Number.isFinite(payload.width)
    && Number.isFinite(payload.height)
    && payload.width >= 100
    && payload.width <= 4000
    && payload.height >= 100
    && payload.height <= 4000;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function easeOutCubic(progress) {
  const value = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  return 1 - Math.pow(1 - value, 3);
}

function interpolateBounds(from, to, progress) {
  const eased = easeOutCubic(progress);
  const interpolate = key => Math.round(from[key] + (to[key] - from[key]) * eased);
  return {
    x: interpolate("x"),
    y: interpolate("y"),
    width: interpolate("width"),
    height: interpolate("height"),
  };
}

function calculateBounds(mode, measurement, display) {
  const area = display?.workArea || display?.bounds;
  if (!area || !Number.isFinite(area.width) || !Number.isFinite(area.height) || area.width <= 0 || area.height <= 0) return null;
  const expanded = typeof mode === "string" && mode.endsWith("expanded");
  let width;
  let height;
  if (!expanded) {
    width = Math.min(COMPACT.width, Math.floor(area.width));
    height = Math.min(COMPACT.height, Math.floor(area.height));
  } else {
    const availableWidth = Math.max(1, Math.floor(area.width));
    const availableHeight = Math.max(1, Math.floor(area.height));
    const minWidth = Math.min(EXPANDED.minWidth, availableWidth);
    const maxWidth = Math.max(minWidth, Math.min(EXPANDED.maxWidth, availableWidth));
    const minHeight = Math.min(EXPANDED.minHeight, availableHeight);
    const maxHeight = Math.max(minHeight, Math.min(EXPANDED.maxHeight, availableHeight));
    const requestedWidth = Number.isFinite(measurement?.width) ? Math.ceil(measurement.width) : EXPANDED.width;
    const requestedHeight = Number.isFinite(measurement?.height) ? Math.ceil(measurement.height) : EXPANDED.height;
    width = clamp(requestedWidth, minWidth, maxWidth);
    height = clamp(requestedHeight, minHeight, maxHeight);
  }
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y),
    width,
    height,
  };
}

class IslandController {
  constructor(options) {
    this.BrowserWindow = options.BrowserWindow;
    this.screen = options.screen;
    this.nativeTheme = options.nativeTheme;
    this.ipcMain = options.ipcMain;
    this.clipboard = options.clipboard;
    this.approvals = options.approvalStore;
    this.inputRequests = options.inputRequestStore;
    this.completions = options.completionStore;
    this.localization = options.localization || createLocalizer({ preference: "system", systemLocale: "en-US" });
    this.platformAdapter = options.platformAdapter || null;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.preloadPath = options.preloadPath || path.join(__dirname, "preload.js");
    this.htmlPath = options.htmlPath || path.join(__dirname, "renderer", "index.html");
    this.window = null;
    this.expandedApprovalId = null;
    this.lastApprovalId = null;
    this.currentDisplay = null;
    this.measurement = null;
    this.measuredCurrentId = null;
    this.animateNextBounds = false;
    this.boundsAnimation = null;
    this.boundsAnimationTimer = null;
    this.positionVersion = 0;
    this.disposers = [];
    this.onChanged = options.onChanged || (() => {});
  }

  create() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new this.BrowserWindow({
      width: COMPACT.width,
      height: COMPACT.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = win;
    this.platformAdapter?.configureWindow?.(win);
    try { win.setAlwaysOnTop(true, "pop-up-menu"); } catch {}
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.on("close", event => {
      if (!win.__allowClose) {
        event.preventDefault();
        this.closeCurrent();
      }
    });
    win.loadFile(this.htmlPath);
    win.webContents.once("did-finish-load", () => this.refresh("ready"));
    this.bind();
    return win;
  }

  bind() {
    const approvalChanged = (_snapshot, reason) => {
      const id = this.approvals.current?.id || null;
      if (id !== this.lastApprovalId) {
        this.expandedApprovalId = null;
        this.lastApprovalId = id;
      }
      if (id && this.completions.current) this.completions.clear("approval-preempted");
      this.refresh(reason);
    };
    const inputChanged = (_snapshot, reason) => {
      if (this.inputRequests.current && this.completions.current) this.completions.clear("input-request-preempted");
      this.refresh(reason || "input-request");
    };
    const completionChanged = () => this.refresh("completion");
    const themeChanged = () => this.refresh("theme");
    this.approvals.on("changed", approvalChanged);
    this.inputRequests.on("changed", inputChanged);
    this.completions.on("changed", completionChanged);
    this.nativeTheme.on("updated", themeChanged);
    this.disposers.push(() => this.approvals.off("changed", approvalChanged));
    this.disposers.push(() => this.inputRequests.off("changed", inputChanged));
    this.disposers.push(() => this.completions.off("changed", completionChanged));
    this.disposers.push(() => this.nativeTheme.off("updated", themeChanged));

    const displayChanged = () => this.refreshPosition();
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
      this.screen.on(event, displayChanged);
      this.disposers.push(() => this.screen.off(event, displayChanged));
    }

    this.handleIpc("island:decision", (event, payload) => {
      if (!this.validSender(event)) {
        this.logger.warn("Rejected renderer decision", { reason: "invalid-sender" });
        return;
      }
      const current = this.approvals.current;
      if (!validDecisionPayload(payload, current)) {
        this.logger.warn("Rejected renderer decision", { reason: "invalid-payload", currentId: current?.id || null });
        return;
      }
      const accepted = this.approvals.resolve(payload.approvalId, payload.optionId, { answers: payload.answers });
      this.logger.info("Renderer decision received", {
        accepted,
        agentId: current.agentId,
        approvalId: current.id,
        answerCount: payload.answers && typeof payload.answers === "object" ? Object.keys(payload.answers).length : 0,
        optionId: payload.optionId,
        tool: current.toolName,
      });
    });
    this.handleIpc("island:close", (event, payload) => {
      if (!this.validSender(event) || !payload || typeof payload.id !== "string") return;
      if (this.approvals.current?.id === payload.id) this.approvals.resolve(payload.id, "no-decision");
      else if (this.inputRequests.current?.id === payload.id) this.inputRequests.dismiss(payload.id);
      else if (this.completions.current?.id === payload.id) this.completions.clear("user-closed");
    });
    this.handleIpc("island:copy", (event, payload) => {
      if (!this.validSender(event) || !validCopyPayload(payload)) return;
      this.clipboard.writeText(payload.text);
    });
    this.handleIpc("island:view", (event, payload) => {
      if (!this.validSender(event)) return;
      const state = this.state();
      if (!validViewPayload(payload, state.current?.id, state.mode.endsWith("expanded"))) return;
      if (payload.action === "expand") this.expand(payload.id);
      else if (payload.action === "collapse") this.collapse(payload.id);
      else if (payload.action === "measure") this.applyBounds({ width: payload.width, height: payload.height });
    });
  }

  handleIpc(channel, handler) {
    this.ipcMain.on(channel, handler);
    this.disposers.push(() => this.ipcMain.removeListener(channel, handler));
  }

  validSender(event) {
    return !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  state() {
    const t = (key, params) => this.localization.t(key, params);
    const view = {
      theme: this.nativeTheme.shouldUseDarkColors ? "dark" : "light",
      locale: this.localization.locale,
      strings: this.localization.rendererStrings(),
    };
    const approval = this.approvals.snapshot();
    if (approval.current) {
      const { toolInput, ...current } = approval.current;
      return {
        mode: this.expandedApprovalId === approval.current.id ? "approval-expanded" : "approval-compact",
        current: {
          ...this.localizeEntry(current),
          presentation: formatApprovalInput(toolInput, approval.current.description, t),
        },
        pendingCount: approval.pendingCount,
        ...view,
      };
    }
    const completion = this.completions.snapshot();
    const inputRequest = this.inputRequests.snapshot();
    if (inputRequest.current) {
      return {
        mode: inputRequest.current.expanded ? "input-request-expanded" : "input-request-compact",
        current: this.localizeEntry(inputRequest.current),
        pendingCount: inputRequest.pendingCount,
        ...view,
      };
    }
    if (completion) {
      return {
        mode: completion.expanded ? "completion-expanded" : "completion-compact",
        current: this.localizeEntry(completion),
        pendingCount: 0,
        ...view,
      };
    }
    return { mode: "hidden", current: null, pendingCount: 0, ...view };
  }

  localizeEntry(entry) {
    if (!entry) return entry;
    const localize = (value, key, params) => value || (key ? this.localization.t(key, params) : "");
    const {
      titleKey, titleParams, contentKey, contentParams, outputKey, outputParams,
      ...safe
    } = entry;
    if (Object.prototype.hasOwnProperty.call(entry, "title")) safe.title = localize(entry.title, titleKey, titleParams);
    if (Object.prototype.hasOwnProperty.call(entry, "content")) safe.content = localize(entry.content, contentKey, contentParams);
    if (Object.prototype.hasOwnProperty.call(entry, "output")) safe.output = localize(entry.output, outputKey, outputParams);
    if (Array.isArray(entry.options)) {
      safe.options = entry.options.map(option => {
        const { labelKey, labelParams, ...display } = option;
        display.label = localize(option.label, labelKey, labelParams);
        return display;
      });
    }
    if (Array.isArray(entry.questions)) {
      safe.questions = entry.questions.map(question => {
        const { questionKey, ...display } = question;
        display.question = localize(question.question, questionKey);
        return display;
      });
    }
    return safe;
  }

  refresh(reason = "changed") {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const state = this.state();
    const currentId = state.current?.id || null;
    if (currentId !== this.measuredCurrentId) {
      this.measuredCurrentId = currentId;
      this.measurement = null;
    }
    this.onChanged(state);
    if (state.mode === "hidden") {
      this.cancelBoundsAnimation();
      win.hide();
      return;
    }
    win.webContents.send("island:state", state);
    this.refreshPosition(this.activeEntry());
    this.applyBounds();
    if (!win.isVisible()) win.showInactive();
    this.logger.info("Island state", { mode: state.mode, reason });
  }

  activeEntry() {
    return this.approvals.current || this.inputRequests.current || this.completions.current;
  }

  async refreshPosition(entry = this.activeEntry()) {
    if (!this.window || this.window.isDestroyed()) return;
    const version = ++this.positionVersion;
    try {
      const display = await locateDisplay(this.screen, entry, { timeoutMs: 400 });
      if (version !== this.positionVersion || !display) return;
      this.currentDisplay = display;
      this.applyBounds();
    } catch (error) {
      this.logger.warn("Display location failed", { message: error.message });
    }
  }

  applyBounds(measurement) {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const state = this.state();
    if (state.mode === "hidden") return;
    if (measurement && Number.isFinite(measurement.width) && Number.isFinite(measurement.height)) {
      this.measurement = { width: measurement.width, height: measurement.height };
    }
    const display = this.currentDisplay || this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint()) || this.screen.getPrimaryDisplay();
    if (!display) return;
    const bounds = calculateBounds(state.mode, this.measurement, display);
    if (!bounds) return;
    if (this.animateNextBounds) {
      this.animateNextBounds = false;
      this.startBoundsAnimation(bounds);
      return;
    }
    if (this.boundsAnimation) {
      this.boundsAnimation.target = bounds;
      return;
    }
    try { win.setBounds(bounds, false); } catch {}
  }

  startBoundsAnimation(target) {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    let from;
    try { from = win.getBounds(); } catch { from = target; }
    this.cancelBoundsAnimation();
    if (!win.isVisible() || Object.keys(target).every(key => from[key] === target[key])) {
      try { win.setBounds(target, false); } catch {}
      return;
    }
    const animation = {
      from,
      target,
      startedAt: Date.now(),
      duration: BOUNDS_ANIMATION_MS,
    };
    this.boundsAnimation = animation;
    const step = () => {
      if (this.boundsAnimation !== animation || !this.window || this.window.isDestroyed()) return;
      const progress = (Date.now() - animation.startedAt) / animation.duration;
      const next = interpolateBounds(animation.from, animation.target, progress);
      try { this.window.setBounds(next, false); } catch {}
      if (progress >= 1) {
        this.boundsAnimation = null;
        this.boundsAnimationTimer = null;
        return;
      }
      this.boundsAnimationTimer = setTimeout(step, BOUNDS_FRAME_MS);
      if (typeof this.boundsAnimationTimer?.unref === "function") this.boundsAnimationTimer.unref();
    };
    step();
  }

  cancelBoundsAnimation() {
    if (this.boundsAnimationTimer) clearTimeout(this.boundsAnimationTimer);
    this.boundsAnimationTimer = null;
    this.boundsAnimation = null;
  }

  expand(id) {
    if (this.approvals.current?.id === id) {
      this.animateNextBounds = true;
      this.expandedApprovalId = id;
      this.refresh("expanded");
      this.window.show();
      this.window.focus();
      return true;
    }
    this.animateNextBounds = true;
    if (this.inputRequests.expand(id)) {
      this.window.show();
      this.window.focus();
      return true;
    }
    this.animateNextBounds = true;
    if (this.completions.expand(id)) {
      this.window.show();
      this.window.focus();
      return true;
    }
    this.animateNextBounds = false;
    return false;
  }

  collapse(id) {
    if (this.approvals.current?.id === id) {
      this.animateNextBounds = true;
      this.expandedApprovalId = null;
      this.refresh("collapsed");
      return true;
    }
    this.animateNextBounds = true;
    if (this.inputRequests.current?.id === id && this.inputRequests.collapse(id)) return true;
    this.animateNextBounds = true;
    if (this.completions.collapse(id)) return true;
    this.animateNextBounds = false;
    return false;
  }

  closeCurrent() {
    const state = this.state();
    if (!state.current) return;
    if (state.current.type === "approval" || state.current.type === "elicitation") this.approvals.resolve(state.current.id, "native");
    else if (state.current.type === "input-request") this.inputRequests.dismiss(state.current.id);
    else this.completions.clear("window-close");
  }

  destroy() {
    this.cancelBoundsAnimation();
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch {}
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.__allowClose = true;
      this.window.destroy();
    }
    this.window = null;
  }
}

module.exports = {
  IslandController,
  COMPACT,
  COMPACT_CONTENT,
  EXPANDED,
  SHADOW_GUTTER,
  BOUNDS_ANIMATION_MS,
  calculateBounds,
  easeOutCubic,
  interpolateBounds,
  validCopyPayload,
  validAnswersPayload,
  validDecisionPayload,
  validViewPayload,
};
