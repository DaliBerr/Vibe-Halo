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
    assert.equal(first.get("language"), "system");
    assert.equal(first.get("historyEnabled"), true);
    assert.equal(first.get("historyPlaintextWarningSeen"), false);
    assert.equal(first.get("historyStorageVersion"), 1);
    first.set("integrationInstalled", false);
    first.set("approvalEnabled", false);
    first.set("inputReminderEnabled", false);
    first.set("historyEnabled", false);
    first.set("historyPlaintextWarningSeen", true);
    assert.equal(first.set("historyStorageVersion", 2), true);
    assert.equal(first.set("historyStorageVersion", 0), false);
    assert.equal(first.set("language", "en-US"), true);
    assert.equal(first.set("language", "fr-FR"), false);
    first.setIntegration("zcode", { disabledByUser: true, detected: true, reason: "disabled-by-user" });
    const second = new SettingsStore(filePath);
    assert.equal(second.get("integrationInstalled"), false);
    assert.equal(second.get("approvalEnabled"), false);
    assert.equal(second.get("inputReminderEnabled"), false);
    assert.equal(second.get("language"), "en-US");
    assert.equal(second.get("historyEnabled"), false);
    assert.equal(second.get("historyPlaintextWarningSeen"), true);
    assert.equal(second.get("historyStorageVersion"), 2);
    assert.equal(second.getIntegration("zcode").disabledByUser, true);
    assert.equal(second.getIntegration("zcode").detected, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid or missing language settings safely migrate to system", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-settings-language-"));
  try {
    const filePath = path.join(root, "settings.json");
    fs.writeFileSync(filePath, JSON.stringify({ approvalEnabled: false, language: "de-DE" }));
    const settings = new SettingsStore(filePath);
    assert.equal(settings.get("approvalEnabled"), false);
    assert.equal(settings.get("language"), "system");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
