"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseDisplay } = require("../src/window-locator");

const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

test("chooses source window display first", () => {
  assert.equal(chooseDisplay([primary, secondary], { x: 2100, y: 100, width: 800, height: 600 }, { x: 10, y: 10 }, primary).id, 2);
});

test("falls back to cursor display and then primary", () => {
  assert.equal(chooseDisplay([primary, secondary], null, { x: 2200, y: 20 }, primary).id, 2);
  assert.equal(chooseDisplay([primary, secondary], null, { x: -500, y: -500 }, primary).id, 1);
});
