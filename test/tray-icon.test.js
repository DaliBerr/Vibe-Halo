"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TRAY_SOURCE_CROP, createTrayImage } = require("../src/tray-icon");

test("tray icon crops the small-size artwork before producing 1x and 2x representations", () => {
  const calls = [];
  const resized = new Map();
  const cropped = {
    resize(options) {
      calls.push(["resize", options]);
      const image = {
        addRepresentation(value) { calls.push(["representation", value]); },
        toDataURL() { return `data:image/png;base64,size-${options.width}`; },
      };
      resized.set(options.width, image);
      return image;
    },
  };
  const nativeImage = {
    createFromPath(sourcePath) {
      calls.push(["source", sourcePath]);
      return {
        isEmpty() { return false; },
        crop(rectangle) { calls.push(["crop", rectangle]); return cropped; },
      };
    },
    createEmpty() { throw new Error("unexpected empty fallback"); },
  };

  const result = createTrayImage(nativeImage, "C:/icons/32x32.png");
  assert.equal(result, resized.get(16));
  assert.deepEqual(calls, [
    ["source", "C:/icons/32x32.png"],
    ["crop", TRAY_SOURCE_CROP],
    ["resize", { width: 16, height: 16, quality: "best" }],
    ["resize", { width: 32, height: 32, quality: "best" }],
    ["representation", { scaleFactor: 2, dataURL: "data:image/png;base64,size-32" }],
  ]);
});

test("tray icon safely returns an empty image when its source cannot be loaded", () => {
  const empty = { empty: true };
  const nativeImage = {
    createFromPath() { return { isEmpty() { return true; } }; },
    createEmpty() { return empty; },
  };
  assert.equal(createTrayImage(nativeImage, "missing.png"), empty);
});

test("tray icon falls back to the uncropped source when crop processing fails", () => {
  const fallback = { fallback: true };
  const source = {
    isEmpty() { return false; },
    crop() { throw new Error("unsupported crop"); },
    resize(options) {
      assert.deepEqual(options, { width: 16, height: 16, quality: "best" });
      return fallback;
    },
  };
  const nativeImage = {
    createFromPath() { return source; },
    createEmpty() { throw new Error("unexpected empty fallback"); },
  };

  assert.equal(createTrayImage(nativeImage, "legacy.png"), fallback);
});
