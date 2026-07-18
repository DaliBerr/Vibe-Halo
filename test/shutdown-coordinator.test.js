"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ShutdownCoordinator } = require("../src/shutdown-coordinator");

test("shutdown is ordered, idempotent, and continues after cleanup errors", async () => {
  const trace = [];
  const warnings = [];
  const coordinator = new ShutdownCoordinator({
    logger: { warn(message, meta) { warnings.push({ message, meta }); } },
    steps: [
      { name: "server", run: async reason => trace.push(`server:${reason}`) },
      { name: "monitor", run: () => { trace.push("monitor"); throw Object.assign(new Error("failed"), { code: "MONITOR_FAILED" }); } },
      { name: "window", run: () => trace.push("window") },
    ],
  });

  const first = coordinator.run("update");
  const second = coordinator.run("quit");
  assert.strictEqual(first, second);
  await first;

  assert.deepEqual(trace, ["server:update", "monitor", "window"]);
  assert.equal(coordinator.reason, "update");
  assert.equal(coordinator.complete, true);
  assert.deepEqual(warnings, [{
    message: "Shutdown step failed",
    meta: { step: "monitor", code: "MONITOR_FAILED" },
  }]);
});
