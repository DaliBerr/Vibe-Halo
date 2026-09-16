"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSmokeTasks, captureSmokeWindow } = require("../src/smoke-test");

test("smoke shutdown waits for asynchronous rendering tasks", async () => {
  const tasks = createSmokeTasks(2000);
  let rendered = false;
  tasks.schedule(5, async () => { await new Promise(resolve => setTimeout(resolve, 30)); rendered = true; });
  await tasks.finish();
  assert.equal(rendered, true);
});
test("smoke task errors are not reported as successful shutdown", async () => {
  const tasks = createSmokeTasks(2000);
  tasks.schedule(0, async () => { throw new Error("capture failed"); });
  await assert.rejects(tasks.finish(), /capture failed/);
});
test("hung smoke capture remains bounded", async () => {
  const tasks = createSmokeTasks(20);
  tasks.schedule(0, () => new Promise(() => {}));
  await assert.rejects(tasks.finish(), /timed out/);
});
test("capture retries empty frames after renderer load before writing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "halo-smoke-"));
  const destination = path.join(directory, "frame.png");
  let loadingChecks = 0, frames = 0;
  const window = { isDestroyed: () => false, webContents: {
    isLoadingMainFrame: () => loadingChecks++ === 0,
    executeJavaScript: async () => true,
    capturePage: async () => ({ isEmpty: () => ++frames === 1, toPNG: () => Buffer.from("loaded-frame") }),
  } };
  try {
    await captureSmokeWindow(window, destination);
    assert.equal(frames, 2);
    assert.equal(fs.readFileSync(destination, "utf8"), "loaded-frame");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
