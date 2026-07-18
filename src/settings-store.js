"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = Object.freeze({
  approvalEnabled: true,
  inputReminderEnabled: true,
  integrationInstalled: true,
  openAtLogin: true,
  initialized: false,
});

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof raw[key] === "boolean") this.value[key] = raw[key];
      }
    } catch {}
    return this.snapshot();
  }

  get(key) {
    return this.value[key];
  }

  set(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key) || typeof value !== "boolean") return false;
    this.value[key] = value;
    this.save();
    return true;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
  }

  snapshot() {
    return { ...this.value };
  }
}

module.exports = { DEFAULTS, SettingsStore };
