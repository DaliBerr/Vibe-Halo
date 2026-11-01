"use strict";

// Keep these in sync with the renderer's body padding and island border radii.
const SHADOW_GUTTER = Object.freeze({ top: 16, right: 40, bottom: 48, left: 40 });
const ISLAND_RADIUS = Object.freeze({ compact: 27, expanded: 24 });

function isInsideIsland(point, bounds, expanded = false) {
  if (!point || !bounds || ![point.x, point.y, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return false;
  const width = bounds.width - SHADOW_GUTTER.left - SHADOW_GUTTER.right;
  const height = bounds.height - SHADOW_GUTTER.top - SHADOW_GUTTER.bottom;
  const x = point.x - bounds.x - SHADOW_GUTTER.left;
  const y = point.y - bounds.y - SHADOW_GUTTER.top;
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) return false;
  const radius = Math.min(ISLAND_RADIUS[expanded ? "expanded" : "compact"], width / 2, height / 2);
  const dx = Math.max(radius - x, 0, x - (width - radius));
  const dy = Math.max(radius - y, 0, y - (height - radius));
  return dx * dx + dy * dy <= radius * radius;
}

class IslandMousePassthrough {
  constructor(win, screen, options = {}) {
    this.win = win;
    this.screen = screen;
    this.expanded = false;
    this.ignored = null;
    this.pressed = new Set();
    this.timer = null;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.onShow = () => this.start();
    this.onHide = () => this.stop();
    this.onBounds = () => this.update();
    this.onBlur = () => { this.pressed.clear(); this.update(); };
    this.onMouse = (_event, mouse) => {
      if (mouse.type === "mouseDown") this.pressed.add(mouse.button);
      else if (mouse.type === "mouseUp") this.pressed.delete(mouse.button);
      this.update();
    };
    win.on("show", this.onShow);
    win.on("hide", this.onHide);
    win.on("closed", this.onHide);
    win.on("resize", this.onBounds);
    win.on("move", this.onBounds);
    win.on("blur", this.onBlur);
    win.webContents.on("before-mouse-event", this.onMouse);
  }

  setExpanded(expanded) {
    this.expanded = expanded;
    this.update();
  }

  update() {
    if (this.win.isDestroyed()) return;
    try {
      const ignore = this.pressed.size === 0
        && !isInsideIsland(this.screen.getCursorScreenPoint(), this.win.getBounds(), this.expanded);
      if (ignore === this.ignored) return;
      this.win.setIgnoreMouseEvents(ignore, { forward: true });
      this.ignored = ignore;
    } catch {
      // A closing window or unavailable cursor must not break event handling.
    }
  }

  start() {
    this.update();
    if (this.timer !== null) return;
    // Linux has no forwarded mouse moves; also recover when Windows forwarding
    // is blocked by an elevated foreground app. Poll only while the island is up.
    this.timer = this.setInterval(() => this.update(), 50);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer !== null) this.clearInterval(this.timer);
    this.timer = null;
    this.pressed.clear();
  }

  destroy() {
    this.stop();
    this.win.removeListener("show", this.onShow);
    this.win.removeListener("hide", this.onHide);
    this.win.removeListener("closed", this.onHide);
    this.win.removeListener("resize", this.onBounds);
    this.win.removeListener("move", this.onBounds);
    this.win.removeListener("blur", this.onBlur);
    this.win.webContents.removeListener("before-mouse-event", this.onMouse);
  }
}

module.exports = { SHADOW_GUTTER, ISLAND_RADIUS, isInsideIsland, IslandMousePassthrough };
