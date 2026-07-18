"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { UpdateManager, cleanPercent, cleanVersion, errorCode } = require("../src/update-manager");

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.check = async () => {};
    this.quitArgs = null;
  }

  checkForUpdates() {
    return this.check();
  }

  quitAndInstall(...args) {
    this.quitArgs = args;
  }
}

function timerOptions() {
  const state = { timeout: null, interval: null, clearedTimeout: false, clearedInterval: false };
  return {
    state,
    options: {
      setTimeout(callback) {
        state.timeout = callback;
        return { unref() {} };
      },
      clearTimeout() { state.clearedTimeout = true; },
      setInterval(callback) {
        state.interval = callback;
        return { unref() {} };
      },
      clearInterval() { state.clearedInterval = true; },
    },
  };
}

test("disabled updater stays inert in unsigned builds", () => {
  const fake = new FakeUpdater();
  const manager = new UpdateManager({ updater: fake, enabled: false, currentVersion: "0.3.0" });
  assert.deepEqual(manager.start(), {
    status: "disabled", currentVersion: "0.3.0", availableVersion: "", percent: null, error: "", enabled: false,
  });
  assert.equal(fake.listenerCount("update-available"), 0);
});

test("manual check reports current version and configures safe update defaults", async () => {
  const fake = new FakeUpdater();
  const timers = timerOptions();
  const manager = new UpdateManager({
    updater: fake, enabled: true, currentVersion: "0.3.0", ...timers.options,
  });
  const results = [];
  manager.on("manual-result", result => results.push(result));
  fake.check = async () => {
    fake.emit("checking-for-update");
    fake.emit("update-not-available", { version: "0.3.0" });
  };

  manager.start();
  const result = await manager.check({ manual: true });

  assert.equal(result.ok, true);
  assert.equal(manager.snapshot().status, "up-to-date");
  assert.deepEqual(results, [{ kind: "up-to-date", version: "" }]);
  assert.equal(fake.autoDownload, true);
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.equal(fake.allowPrerelease, false);
  assert.equal(fake.allowDowngrade, false);
  assert.equal(fake.logger, null);
  assert.equal(typeof timers.state.timeout, "function");
  assert.equal(typeof timers.state.interval, "function");
});

test("downloaded update installs only after the fail-open shutdown callback", async () => {
  const fake = new FakeUpdater();
  const trace = [];
  const manager = new UpdateManager({
    updater: fake,
    enabled: true,
    currentVersion: "0.3.0",
    beforeInstall: async () => trace.push("shutdown"),
    ...timerOptions().options,
  });
  manager.start();
  fake.emit("update-available", { version: "0.3.1" });
  fake.emit("download-progress", { percent: 42.4 });
  assert.equal(manager.snapshot().status, "downloading");
  assert.equal(manager.snapshot().percent, 42);
  fake.emit("update-downloaded", { version: "0.3.1" });

  const installed = await manager.install();

  assert.equal(installed, true);
  assert.deepEqual(trace, ["shutdown"]);
  assert.deepEqual(fake.quitArgs, [true, true]);
  assert.equal(manager.snapshot().status, "installing");
});

test("errors expose only bounded codes and stop removes updater listeners", async () => {
  const fake = new FakeUpdater();
  const timers = timerOptions();
  const logs = [];
  const manager = new UpdateManager({
    updater: fake,
    enabled: true,
    currentVersion: "0.3.0",
    logger: { info() {}, warn(message, meta) { logs.push({ message, meta }); }, error() {} },
    ...timers.options,
  });
  fake.check = async () => { throw Object.assign(new Error("https://example.invalid/?token=secret"), { code: "bad code with spaces" }); };
  manager.start();

  const result = await manager.check({ manual: true });

  assert.deepEqual(result, { ok: false, reason: "check-failed" });
  assert.equal(manager.snapshot().error, "update-failed");
  assert.deepEqual(logs, [{ message: "Update operation failed", meta: { code: "update-failed" } }]);
  manager.stop();
  assert.equal(fake.listenerCount("error"), 0);
  assert.equal(timers.state.clearedTimeout, true);
  assert.equal(timers.state.clearedInterval, true);
});

test("update value cleaners keep renderer-independent state bounded", () => {
  assert.equal(cleanVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(cleanVersion("version 1.2.3"), "");
  assert.equal(cleanPercent(109), 100);
  assert.equal(cleanPercent(-1), 0);
  assert.equal(errorCode({ code: "ERR_UPDATER_42" }), "ERR_UPDATER_42");
  assert.equal(errorCode({ code: "https://example.invalid/token" }), "update-failed");
});
