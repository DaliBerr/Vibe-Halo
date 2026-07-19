"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseDisplay, locateLinuxWindowBounds } = require("../src/window-locator");

const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

test("chooses source window display first", () => {
  assert.equal(chooseDisplay([primary, secondary], { x: 2100, y: 100, width: 800, height: 600 }, { x: 10, y: 10 }, primary).id, 2);
});

test("falls back to cursor display and then primary", () => {
  assert.equal(chooseDisplay([primary, secondary], null, { x: 2200, y: 20 }, primary).id, 2);
  assert.equal(chooseDisplay([primary, secondary], null, { x: -500, y: -500 }, primary).id, 1);
});

test("locates the active X11 window only when its PID belongs to the source chain", async () => {
  const execFile = (command, args, _options, callback) => {
    if (command === "xprop" && args[0] === "-root") {
      callback(null, "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3e00007\n");
      return;
    }
    if (command === "xprop") {
      callback(null, "_NET_WM_PID(CARDINAL) = 4242\n");
      return;
    }
    callback(null, [
      "  Absolute upper-left X:  1920",
      "  Absolute upper-left Y:  40",
      "  Width: 1280",
      "  Height: 900",
    ].join("\n"));
  };
  assert.deepEqual(await locateLinuxWindowBounds([100, 4242], {
    env: { DISPLAY: ":99" },
    execFile,
  }), { x: 1920, y: 40, width: 1280, height: 900 });
  assert.equal(await locateLinuxWindowBounds([100], {
    env: { DISPLAY: ":99" },
    execFile,
  }), null);
});

test("does not invoke X11 helpers when DISPLAY is unavailable", async () => {
  let invoked = false;
  assert.equal(await locateLinuxWindowBounds([4242], {
    env: {},
    execFile: () => { invoked = true; },
  }), null);
  assert.equal(invoked, false);
});
