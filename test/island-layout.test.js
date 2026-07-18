"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BOUNDS_ANIMATION_MS,
  COMPACT,
  COMPACT_CONTENT,
  EXPANDED,
  SHADOW_GUTTER,
  calculateBounds,
  easeOutCubic,
  interpolateBounds,
} = require("../src/island-controller");

const display = {
  workArea: { x: 100, y: 40, width: 1600, height: 900 },
};

test("centers the larger compact island with its transparent gutter at work-area top", () => {
  assert.deepEqual(SHADOW_GUTTER, { top: 8, right: 24, bottom: 28, left: 24 });
  assert.equal(COMPACT.width - SHADOW_GUTTER.left - SHADOW_GUTTER.right, COMPACT_CONTENT.width);
  assert.equal(COMPACT.height - SHADOW_GUTTER.top - SHADOW_GUTTER.bottom, COMPACT_CONTENT.height);
  const bounds = calculateBounds("approval-compact", null, display);
  assert.deepEqual(bounds, {
    x: 100 + Math.round((1600 - COMPACT.width) / 2),
    y: 40,
    width: COMPACT.width,
    height: COMPACT.height,
  });
});

test("uses the default expanded size and accepts bounded renderer measurement", () => {
  assert.deepEqual(calculateBounds("approval-expanded", null, display), {
    x: 100 + Math.round((1600 - EXPANDED.width) / 2),
    y: 40,
    width: EXPANDED.width,
    height: EXPANDED.height,
  });
  const measured = calculateBounds("approval-expanded", { width: 720, height: 580 }, display);
  assert.equal(measured.width, 720);
  assert.equal(measured.height, 580);
  assert.equal(measured.x, 100 + Math.round((1600 - 720) / 2));
});

test("clamps renderer measurement to configured and work-area limits", () => {
  const maximum = calculateBounds("approval-expanded", { width: 4000, height: 4000 }, display);
  assert.equal(maximum.width, EXPANDED.maxWidth);
  assert.equal(maximum.height, EXPANDED.maxHeight);
  const minimum = calculateBounds("approval-expanded", { width: 100, height: 100 }, display);
  assert.equal(minimum.width, EXPANDED.minWidth);
  assert.equal(minimum.height, EXPANDED.minHeight);

  const smallDisplay = { workArea: { x: 0, y: 0, width: 520, height: 300 } };
  const small = calculateBounds("approval-expanded", { width: 760, height: 600 }, smallDisplay);
  assert.deepEqual(small, { x: 0, y: 0, width: 520, height: 300 });
});

test("rejects displays without a usable work area", () => {
  assert.equal(calculateBounds("approval-expanded", null, null), null);
  assert.equal(calculateBounds("approval-expanded", null, { workArea: { x: 0, y: 0, width: 0, height: 100 } }), null);
});

test("interpolates window bounds with a bounded ease-out curve", () => {
  const from = { x: 100, y: 40, width: 348, height: 88 };
  const to = { x: -60, y: 40, width: 668, height: 516 };
  assert.equal(BOUNDS_ANIMATION_MS, 220);
  assert.deepEqual(interpolateBounds(from, to, 0), from);
  assert.deepEqual(interpolateBounds(from, to, 1), to);
  assert.equal(easeOutCubic(0.5), 0.875);
  assert.deepEqual(interpolateBounds(from, to, 0.5), {
    x: -40,
    y: 40,
    width: 628,
    height: 463,
  });
  assert.deepEqual(interpolateBounds(from, to, Number.NaN), from);
});
