"use strict";

const fs = require("node:fs");
const path = require("node:path");

class DeviceCredentialStore {
  constructor({ filePath, safeStorage, platform = process.platform }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.value = null;
  }
  available() {
    return this.safeStorage?.isEncryptionAvailable() === true
      && !(this.platform === "linux" && this.safeStorage.getSelectedStorageBackend?.() === "basic_text");
  }
  load() {
    if (!this.available()) throw new Error("secure_storage_unavailable");
    if (!fs.existsSync(this.filePath)) return null;
    if (fs.statSync(this.filePath).size > 1024 * 1024) throw new Error("credential_store_invalid");
    try {
      const envelope = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (envelope.version !== 1 || typeof envelope.ciphertext !== "string") throw new Error();
      const value = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64")));
      if (value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 32) throw new Error();
      this.value = value;
      return value;
    } catch { throw new Error("credential_store_invalid"); }
  }
  save(value) {
    if (!this.available()) throw new Error("secure_storage_unavailable");
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 700000) throw new Error("credential_store_full");
    const envelope = JSON.stringify({ version: 1, ciphertext: this.safeStorage.encryptString(text).toString("base64") });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, envelope, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    this.value = value;
  }
}
module.exports = { DeviceCredentialStore };
