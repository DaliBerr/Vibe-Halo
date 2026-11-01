"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");
const { SHADOW_GUTTER, ISLAND_RADIUS, isInsideIsland, IslandMousePassthrough } = require("../src/island-mouse-passthrough");
const { COMPACT, EXPANDED } = require("../src/island-controller");

test("only the visible rounded island catches clicks, including on negative-coordinate displays", () => {
  const bounds = { x: -1200, y: 40, ...COMPACT };
  const point = (x, y) => ({ x: bounds.x + x, y: bounds.y + y });
  for (const [x, y] of [[190, 0], [0, 42], [379, 42], [190, 115], [40, 16], [339, 67], [39.5, 42]]) {
    assert.equal(isInsideIsland(point(x, y), bounds), false, `${x}, ${y} passes through`);
  }
  for (const [x, y] of [[190, 16], [40, 42], [339, 42], [66, 17], [190, 67]]) {
    assert.equal(isInsideIsland(point(x, y), bounds), true, `${x}, ${y} remains interactive`);
  }
  // Electron cursor and bounds are both DIP, so fractions need no DPI scaling.
  assert.equal(isInsideIsland(point(40.25, 42), bounds), true);
  assert.equal(isInsideIsland(null, bounds), false);
  assert.equal(isInsideIsland({ x: NaN, y: 1 }, bounds), false);
  assert.equal(isInsideIsland(point(40, 42), { ...bounds, width: 50 }), false);
  const expanded = { x: 0, y: 0, width: EXPANDED.width, height: EXPANDED.height };
  assert.equal(isInsideIsland({ x: 41, y: 17 }, expanded, true), false);
  assert.equal(isInsideIsland({ x: 64, y: 16 }, expanded, true), true);
  assert.equal(isInsideIsland({ x: 660, y: 250 }, expanded, true), false);
  assert.equal(isInsideIsland({ x: 650, y: 250 }, expanded, true), true);
});

test("shadow hit testing matches CSS and preserves the original visible content sizes", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/style.css"), "utf8");
  const { top, right, bottom, left } = SHADOW_GUTTER;
  assert.match(css, new RegExp(`body \\{ padding: ${top}px ${right}px ${bottom}px;`));
  assert.equal(right, left);
  for (const [mode, radius] of Object.entries(ISLAND_RADIUS)) {
    assert.match(css, new RegExp(`\\.island\\.${mode} \\{ border-radius: ${radius}px;`));
  }
  assert.equal(COMPACT.width - left - right, 300);
  assert.equal(COMPACT.height - top - bottom, 52);
  assert.equal(EXPANDED.width - left - right, 620);
  assert.equal(EXPANDED.height - top - bottom, 480);
});

function fixture(t) {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isDestroyed = () => false;
  win.bounds = { x: 0, y: 0, ...COMPACT };
  win.getBounds = () => win.bounds;
  win.calls = [];
  win.setIgnoreMouseEvents = (...args) => win.calls.push(args);
  const screen = { point: { x: 190, y: 42 }, getCursorScreenPoint() { return this.point; } };
  const timers = new Map();
  const mouse = new IslandMousePassthrough(win, screen, {
    setInterval(callback, delay) { const timer = { delay }; timers.set(timer, callback); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  });
  t.after(() => mouse.destroy());
  return { win, screen, mouse, timers, tick: () => [...timers.values()].forEach(callback => callback()) };
}

test("forwarded movement restores island controls and leaves shadow clicks to the window below", t => {
  const { win, screen, timers } = fixture(t);
  screen.point = { x: 1, y: 42 };
  win.emit("show");
  assert.deepEqual(win.calls, [[true, { forward: true }]]);
  screen.point = { x: 190, y: 42 };
  win.webContents.emit("before-mouse-event", {}, { type: "mouseMove" });
  assert.deepEqual(win.calls.at(-1), [false, { forward: true }]);
  win.webContents.emit("before-mouse-event", {}, { type: "mouseMove" });
  assert.equal(win.calls.length, 2);
  screen.point = { x: 41, y: 17 };
  win.webContents.emit("before-mouse-event", {}, { type: "mouseMove" });
  assert.deepEqual(win.calls.at(-1), [true, { forward: true }]);
  assert.equal(timers.size, 1);
});

test("cursor polling recovers without forwarded events and follows animated size and display changes", t => {
  const { win, screen, mouse, tick, timers } = fixture(t);
  win.emit("show");
  win.emit("show");
  assert.equal(timers.size, 1);
  screen.point = { x: 500, y: 250 };
  tick();
  assert.equal(win.calls.at(-1)[0], true);
  mouse.setExpanded(true);
  win.bounds = { x: 0, y: 0, width: EXPANDED.width, height: EXPANDED.height };
  win.emit("resize");
  assert.equal(win.calls.at(-1)[0], false);
  win.bounds = { ...win.bounds, x: -1200 };
  win.emit("move");
  assert.equal(win.calls.at(-1)[0], true);
  screen.point.x -= 1200;
  tick();
  assert.equal(win.calls.at(-1)[0], false);
  win.emit("hide");
  assert.equal(timers.size, 0);
  screen.point = { x: 0, y: 0 };
  win.emit("show");
  assert.equal(win.calls.at(-1)[0], true);
  mouse.destroy();
  assert.equal(timers.size, 0);
  assert.equal(win.webContents.listenerCount("before-mouse-event"), 0);
  assert.equal(win.listenerCount("show"), 0);
});

test("drag selection keeps mouse capture until release, blur or hiding", t => {
  const { win, screen, tick } = fixture(t);
  win.emit("show");
  win.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left" });
  screen.point = { x: 10, y: 10 };
  tick();
  assert.equal(win.calls.at(-1)[0], false);
  win.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
  assert.equal(win.calls.at(-1)[0], true);
  screen.point = { x: 190, y: 42 };
  tick();
  win.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left" });
  screen.point = { x: 10, y: 10 };
  win.emit("blur");
  assert.equal(win.calls.at(-1)[0], true);
  win.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left" });
  win.emit("hide");
  win.emit("show");
  assert.equal(win.calls.at(-1)[0], true);
});
