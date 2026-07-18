"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { SettingsStore } = require("../src/settings-store");

test("persists integration ownership independently from approval toggle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-settings-"));
  try {
    const filePath = path.join(root, "settings.json");
    const first = new SettingsStore(filePath);
    assert.equal(first.get("integrationInstalled"), true);
    assert.equal(first.get("inputReminderEnabled"), true);
    first.set("integrationInstalled", false);
    first.set("approvalEnabled", false);
    first.set("inputReminderEnabled", false);
    const second = new SettingsStore(filePath);
    assert.equal(second.get("integrationInstalled"), false);
    assert.equal(second.get("approvalEnabled"), false);
    assert.equal(second.get("inputReminderEnabled"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
