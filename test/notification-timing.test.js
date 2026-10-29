"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { notificationTiming } = require("../src/notification-timing");
const { parseTiming, report } = require("../scripts/analyze-notification-timing");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("CLI reads pretty-printed Wrangler invocations alongside logcat lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-timing-"));
  try {
    const row = { code: "notification_timing", host: "relay", stage: "relay_push_due", eventId: "evt_test", atMs: 100 };
    const file = path.join(dir, "capture.log");
    fs.writeFileSync(file, JSON.stringify({ logs: [{ message: [JSON.stringify(row)] }] }, null, 2) + "\nI VibeHaloTiming: " + JSON.stringify({ ...row, host: "android" }) + "\n");
    const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "../scripts/analyze-notification-timing.js"), file], { encoding: "utf8" }));
    assert.equal(result.events[0].stages.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("timing telemetry strips content and logger failures cannot interrupt delivery", () => {
  let saved;
  notificationTiming({ info: (_message, value) => { saved = value; } }, "desktop_event_ready", "evt_test", 1,
    { sourceAtMs: 10, detectedAtMs: 12, elapsedMs: 2, token: "secret", content: "private", other: { password: "secret" } });
  assert.equal(saved.detectedAtMs, 12);
  assert.equal(JSON.stringify(saved).includes("secret"), false);
  assert.equal(JSON.stringify(saved).includes("private"), false);
  assert.doesNotThrow(() => notificationTiming({ info() { throw Error("disk full"); } }, "desktop_event_ready", "evt_test"));
});

test("timing report joins rotated desktop, Wrangler and logcat events without treating clock skew as delay", () => {
  const row = { code: "notification_timing", host: "desktop", stage: "desktop_event_ready", eventId: "evt_test", atMs: 200, content: "private" };
  const desktop = parseTiming("timestamp INFO notification_timing " + JSON.stringify(row));
  const relay = parseTiming(JSON.stringify({ logs: [{ message: [JSON.stringify({ ...row, host: "relay", stage: "relay_fcm_accepted", atMs: 100, elapsedMs: 12 })] }] }));
  const android = parseTiming("10-29 I VibeHaloTiming: " + JSON.stringify({ ...row, host: "android", stage: "android_notify_returned", atMs: 150, elapsedMs: 4 }));
  const result = report([...desktop, ...relay, ...android]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].stages.length, 3);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.match(result.warning, /not synchronized/);
  assert.deepEqual(parseTiming("invalid"), []);
  assert.equal(parseTiming("logcat: " + JSON.stringify({ host: "android", ...row })).length, 1);
  assert.deepEqual(parseTiming(JSON.stringify({ ...row, eventId: "invalid\nidentifier" })), []);
});
