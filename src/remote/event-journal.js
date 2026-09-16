"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { validate } = require("../../packages/protocol");

class EventJournal {
  constructor({ filePath, safeStorage }) {
    this.filePath = filePath; this.safeStorage = safeStorage; this.events = new Map(); this.sequence = 0; this.damaged = false;
  }
  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      if (fs.statSync(this.filePath).size > 15 * 1024 * 1024) throw new Error();
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const values = JSON.parse(this.safeStorage.decryptString(Buffer.from(data.ciphertext, "base64")));
      if (data.version !== 1 || !Array.isArray(values) || values.length > 500) throw new Error();
      for (const value of values) {
        if (!validate("eventDetail", value).ok) throw new Error();
        this.sequence = Math.max(this.sequence, value.summary.streamSeq);
        if (value.summary.state === "pending") {
          value.summary.state = "expired"; value.summary.actionable = false; value.remoteActionable = false;
          value.summary.eventRevision += 1; value.summary.streamSeq = ++this.sequence;
        }
        this.events.set(value.summary.eventId, value);
      }
      this.prune();
    } catch { this.events.clear(); this.damaged = true; throw new Error("remote_journal_invalid"); }
  }
  put(value) {
    if (!validate("eventDetail", value).ok) return false;
    const previous = this.events.get(value.summary.eventId);
    if (previous && previous.summary.eventRevision >= value.summary.eventRevision) return false;
    value = structuredClone(value); value.summary.streamSeq = ++this.sequence;
    this.events.set(value.summary.eventId, value); this.prune();
    clearTimeout(this.timer); this.timer = setTimeout(() => { try { this.flush(); } catch { this.damaged = true; } }, 250); this.timer.unref();
    return true;
  }
  prune() {
    for (const [key, value] of this.events) if (Date.parse(value.summary.createdAt) < Date.now() - 86400000) this.events.delete(key);
    let bytes = Buffer.byteLength(JSON.stringify([...this.events.values()]));
    while (this.events.size > 500 || bytes > 10 * 1024 * 1024) {
      const key = this.events.keys().next().value;
      bytes -= Buffer.byteLength(JSON.stringify(this.events.get(key))) + 1; this.events.delete(key);
    }
  }
  flush() {
    clearTimeout(this.timer);
    if (this.damaged) throw new Error("remote_journal_invalid");
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("secure_storage_unavailable");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const ciphertext = this.safeStorage.encryptString(JSON.stringify([...this.events.values()])).toString("base64");
    fs.writeFileSync(`${this.filePath}.tmp`, JSON.stringify({ version: 1, ciphertext }), { mode: 0o600 });
    fs.renameSync(`${this.filePath}.tmp`, this.filePath);
  }
  list() { this.prune(); return [...this.events.values()].sort((a, b) => b.summary.streamSeq - a.summary.streamSeq); }
}
module.exports = { EventJournal };
