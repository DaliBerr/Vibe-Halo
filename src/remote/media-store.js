"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createHash, randomUUID } = require("node:crypto");
const { Parser } = require("commonmark");
const { imageSize } = require("image-size");

const MAX_IMAGES = 4, MAX_SOURCE = 8 * 1024 * 1024, MAX_IMAGE = 256 * 1024;
const MAX_CACHE = 16 * 1024 * 1024, CHUNK_BYTES = 24 * 1024, RETENTION = 86400000;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function imageReferences(content) {
  const walker = new Parser().parse(String(content).slice(0, 48000)).walker();
  const found = new Set(); let entry;
  while ((entry = walker.next())) {
    if (!entry.entering || !["image", "link"].includes(entry.node.type)) continue;
    const ref = entry.node.destination;
    if (ref.length <= 2048 && /\.(png|jpe?g|webp|gif)$/i.test(ref)) found.add(ref);
    if (found.size === MAX_IMAGES) break;
  }
  return [...found];
}

// Only project-local, explicitly referenced raster files. Never fetch URLs or UNC paths.
async function readProjectImage(cwd, reference) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /^[\\/]{2}/.test(cwd)) throw new Error("unavailable");
  let target = decodeURIComponent(reference);
  if (/^file:/i.test(target)) target = fileURLToPath(target);
  if (/^\/[A-Za-z]:\//.test(target)) target = target.slice(1);
  if (target.replace(/^[A-Za-z]:/, "").includes(":")) throw new Error("unavailable");
  if (/^[\\/]{2}/.test(target) || /[\x00-\x1f]/.test(target) || /^(?![A-Za-z]:[\\/])[A-Za-z][\w+.-]*:/.test(target)) throw new Error("unavailable");
  const root = await fs.promises.realpath(cwd);
  const candidate = path.resolve(root, target);
  const inside = value => { const relative = path.relative(root, value); return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
  if (!inside(candidate)) throw new Error("unavailable");
  const resolved = await fs.promises.realpath(candidate);
  if (!inside(resolved)) throw new Error("unavailable");
  const file = await fs.promises.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_SOURCE) throw new Error("unavailable");
    // Fixed-size read: a concurrently growing file cannot exhaust memory.
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) { const read = await file.read(bytes, position, bytes.length - position, position); if (!read.bytesRead) throw new Error("unavailable"); position += read.bytesRead; }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await fs.promises.realpath(candidate) !== resolved) throw new Error("unavailable");
    const size = imageSize(bytes);
    if (!["png", "jpg", "webp", "gif"].includes(size.type) || !size.width || !size.height || size.width * size.height > 16000000 || Math.max(size.width, size.height) > 16000) throw new Error("unavailable");
    return bytes;
  } finally { await file.close(); }
}

function rasterize(bytes) {
  const { nativeImage } = require("electron");
  const original = nativeImage.createFromBuffer(bytes);
  if (original.isEmpty()) throw new Error("unavailable");
  function variant(maxEdge, maxBytes) {
    let image = original;
    const size = original.getSize(), scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "best" });
    let output = image.toPNG(), mime = "image/png";
    if (output.length > maxBytes) { output = image.toJPEG(80); mime = "image/jpeg"; }
    while (output.length > maxBytes && image.getSize().width > 160 && image.getSize().height > 160) {
      const current = image.getSize(); image = image.resize({ width: Math.round(current.width * 0.75), height: Math.round(current.height * 0.75) }); output = image.toJPEG(75);
    }
    if (!output.length || output.length > maxBytes) throw new Error("unavailable");
    return { ...image.getSize(), mime, size: output.length, sha256: digest(output), data: output.toString("base64") };
  }
  return { preview: variant(480, 48 * 1024), full: variant(2048, MAX_IMAGE) };
}

class MediaStore {
  constructor({ filePath, safeStorage, processImage = rasterize, now = Date.now }) {
    Object.assign(this, { filePath, safeStorage, processImage, now }); this.records = new Map(); this.pending = new Map(); this.damaged = false;
  }
  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      if (fs.statSync(this.filePath).size > 40 * 1024 * 1024) throw new Error();
      const saved = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.filePath)));
      if (saved.version !== 1 || !Array.isArray(saved.records) || saved.records.length > 100) throw new Error();
      for (const record of saved.records) {
        if (typeof record.key !== "string" || !Number.isSafeInteger(record.expiresAt) || !Array.isArray(record.items) || record.items.length > MAX_IMAGES) throw new Error();
        for (const item of record.items) {
          if (typeof item.id !== "string" || typeof item.reference !== "string" || item.reference.length > 2048) throw new Error();
          for (const name of ["preview", "full"]) {
            const part = item[name]; const bytes = Buffer.from(part.data, "base64");
            if (!bytes.length || bytes.length > (name === "preview" ? 48 * 1024 : MAX_IMAGE) || bytes.length !== part.size || digest(bytes) !== part.sha256 || !["image/png", "image/jpeg"].includes(part.mime)
              || !Number.isInteger(part.width) || !Number.isInteger(part.height) || part.width < 1 || part.height < 1 || Math.max(part.width, part.height) > 2048) throw new Error();
          }
        }
        this.records.set(record.key, record);
      }
      this.prune();
    } catch { this.records.clear(); this.damaged = true; }
  }
  capture(key, content, cwd) {
    if (this.damaged || this.records.has(key) || this.pending.has(key) || this.pending.size >= 8) return;
    let references;
    try { references = imageReferences(content); } catch { return; }
    if (!references.length) return;
    const flight = (async () => {
      const items = [];
      for (const reference of references) {
        try { items.push({ id: randomUUID(), reference, ...await this.processImage(await readProjectImage(cwd, reference)) }); } catch { /* A missing image never blocks text or approvals. */ }
      }
      this.records.set(key, { key, expiresAt: this.now() + RETENTION, items }); this.prune();
      clearTimeout(this.timer); this.timer = setTimeout(() => { try { this.flush(); } catch { /* Keep the in-memory bounded snapshot. */ } }, 250); this.timer.unref();
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, flight);
  }
  prune() {
    for (const [key, record] of this.records) if (record.expiresAt <= this.now()) this.records.delete(key);
    let size = [...this.records.values()].reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0);
    while (this.records.size > 100 || size > MAX_CACHE) { const key = this.records.keys().next().value; size -= Buffer.byteLength(JSON.stringify(this.records.get(key))); this.records.delete(key); }
  }
  async list(key) {
    await this.pending.get(key); this.prune();
    return (this.records.get(key)?.items || []).map(item => ({ id: item.id, reference: item.reference,
      ...Object.fromEntries(["preview", "full"].map(name => { const { data, ...meta } = item[name]; return [name, meta]; })) }));
  }
  read(key, id, variant, offset) {
    this.prune();
    if (!["preview", "full"].includes(variant) || !Number.isInteger(offset) || offset < 0 || offset % CHUNK_BYTES) throw new Error("invalid_media_request");
    const part = this.records.get(key)?.items.find(item => item.id === id)?.[variant];
    if (!part || offset >= part.size) throw new Error("media_unavailable");
    const bytes = Buffer.from(part.data, "base64").subarray(offset, offset + CHUNK_BYTES);
    return { id, variant, offset, size: part.size, sha256: part.sha256, data: bytes.toString("base64"), nextOffset: offset + bytes.length < part.size ? offset + bytes.length : null };
  }
  flush() {
    clearTimeout(this.timer); this.prune();
    if (this.damaged || !this.safeStorage.isEncryptionAvailable()) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = this.safeStorage.encryptString(JSON.stringify({ version: 1, records: [...this.records.values()] }));
    fs.writeFileSync(`${this.filePath}.tmp`, encrypted, { mode: 0o600 }); fs.renameSync(`${this.filePath}.tmp`, this.filePath);
  }
  async close() { await Promise.allSettled(this.pending.values()); try { this.flush(); } catch { /* Optional media must not delay fail-open shutdown on disk errors. */ } }
}
module.exports = { MediaStore, imageReferences, readProjectImage, rasterize, CHUNK_BYTES, MAX_IMAGES, MAX_IMAGE };
