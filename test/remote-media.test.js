"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { MediaStore, imageReferences, readProjectImage, CHUNK_BYTES } = require("../src/remote/media-store");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const variant = bytes => ({ width: 1, height: 1, mime: "image/png", size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-media-"));
  const key = crypto.randomBytes(32);
  const storage = { isEncryptionAvailable: () => true,
    encryptString(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    decryptString(bytes) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(); } };
  let now = Date.now();
  const options = { filePath: path.join(dir, "cache.enc"), safeStorage: storage, processImage: bytes => ({ preview: variant(bytes), full: variant(bytes) }), now: () => now };
  const store = new MediaStore(options);
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, "project")); const cwd = path.join(dir, "project"); fs.writeFileSync(path.join(cwd, "a.png"), png);
  return { store, options, dir, cwd, advance: () => { now += 86400001; } };
}
test("image references handle local links, spaces, references and fences without scanning arbitrary text", () => {
  const content = '![预览](<C:/Unity Project/out.png>)\n[图片](./a.png)\n![引用][pic]\n\n[pic]: ./b.jpg\n\n`![ignore](private.png)`\n\n```md\n![ignore](secret.png)\n```\nplain.png';
  assert.deepEqual(imageReferences(content), ["C:/Unity%20Project/out.png", "./a.png", "./b.jpg"]);
  assert.equal(imageReferences(Array.from({ length: 20 }, (_, i) => `![x](${i}.png)`).join("\n")).length, 4);
});
test("file reads reject URLs, traversal, symlink escape, invalid rasters, huge dimensions and oversized files", async t => {
  const { cwd, dir } = fixture(t);
  assert.deepEqual(await readProjectImage(cwd, "a.png"), png);
  fs.writeFileSync(path.join(dir, "outside.png"), png);
  for (const ref of ["../outside.png", path.join(dir, "outside.png"), "https://example.com/a.png", "//server/share/a.png", "\\\\server\\share\\a.png", "%00.png", "a.png:secret", "data:image/png;base64,AA"]) await assert.rejects(readProjectImage(cwd, ref));
  fs.mkdirSync(path.join(dir, "outside")); fs.writeFileSync(path.join(dir, "outside", "secret.png"), png);
  fs.symlinkSync(path.join(dir, "outside"), path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readProjectImage(cwd, "escape/secret.png"));
  fs.writeFileSync(path.join(cwd, "fake.png"), "not an image, just text"); await assert.rejects(readProjectImage(cwd, "fake.png"));
  const huge = Buffer.from(png); huge.writeUInt32BE(50000, 16); fs.writeFileSync(path.join(cwd, "huge.png"), huge); await assert.rejects(readProjectImage(cwd, "huge.png"));
  fs.writeFileSync(path.join(cwd, "large.png"), Buffer.alloc(8 * 1024 * 1024 + 1)); await assert.rejects(readProjectImage(cwd, "large.png"));
});
test("snapshots survive original deletion and encrypted restart, and expire without rereading old paths", async t => {
  const { store, cwd, options, advance } = fixture(t);
  store.capture("event:new", "![x](a.png)", cwd);
  const [item] = await store.list("event:new"); assert.ok(item); assert.equal(item.full.data, undefined);
  fs.unlinkSync(path.join(cwd, "a.png")); store.flush();
  assert.equal(fs.readFileSync(options.filePath).includes(Buffer.from("a.png")), false);
  const restored = new MediaStore(options); restored.load();
  assert.deepEqual(await restored.list("event:new"), [item]);
  assert.equal(restored.read("event:new", item.id, "full", 0).data, png.toString("base64"));
  assert.deepEqual(await restored.list("event:old"), []);
  assert.throws(() => restored.read("event:other", item.id, "full", 0));
  advance(); assert.deepEqual(await restored.list("event:new"), []);
});
test("chunks are fixed-size, hash-bound and never accept paths or invalid offsets", async t => {
  const { store, cwd } = fixture(t); const bytes = crypto.randomBytes(CHUNK_BYTES * 2 + 9);
  store.processImage = () => ({ preview: variant(png), full: variant(bytes) });
  store.capture("event:new", "![x](a.png)", cwd); const [item] = await store.list("event:new");
  const chunks = [0, CHUNK_BYTES, CHUNK_BYTES * 2].map(offset => store.read("event:new", item.id, "full", offset));
  assert.equal(chunks[2].nextOffset, null); assert.equal(chunks[0].nextOffset, CHUNK_BYTES);
  assert.deepEqual(Buffer.concat(chunks.map(part => Buffer.from(part.data, "base64"))), bytes);
  for (const offset of [-1, 1, 0.1, NaN, 999999]) assert.throws(() => store.read("event:new", item.id, "full", offset));
  assert.throws(() => store.read("event:new", "a.png", "full", 0));
  assert.throws(() => store.read("event:new", item.id, "original", 0));
});
test("damaged cache is preserved and failed image processing leaves an empty attachment list", async t => {
  const { store, cwd, options } = fixture(t);
  store.processImage = () => { throw new Error("decode_failed"); };
  store.capture("event:new", "![x](a.png)", cwd); assert.deepEqual(await store.list("event:new"), []);
  await store.close(); fs.writeFileSync(options.filePath, "damaged");
  const restored = new MediaStore(options); restored.load(); restored.capture("event:x", "![x](a.png)", cwd); restored.flush();
  assert.equal(restored.damaged, true); assert.equal(fs.readFileSync(options.filePath, "utf8"), "damaged");
});
