"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const START = "# >>> Vibe Halo integration (deepseek-harness) >>>";
const END = "# <<< Vibe Halo integration (deepseek-harness) <<<";
const ID = "vibe-halo-dsh";
const lf = text => text.replace(/\r\n/g, "\n");

function withoutBlock(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return text;
  if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0
    || text.indexOf(END, end + END.length) >= 0) throw new Error("invalid-dsh-managed-block");
  // DSH's YAML writer can wrap the file URL and append unrelated top-level
  // patches before our trailing comment. The comments alone do not own those
  // patches: remove only the exact plugin row we generated, preserving the rest.
  const body = text.slice(start + START.length, end);
  const row = /^\r?\n- insert:\r?\n    - id: vibe-halo-dsh\r?\n      name: ("(?:[^"\\]|\\(?:\r?\n[ \t]*|[^\r\n]))*")\r?\n/.exec(body);
  if (!row) throw new Error("dsh-plugin-user-override");
  let url;
  try { url = new URL(JSON.parse(row[1].replace(/\\\r?\n[ \t]*/g, ""))); }
  catch { throw new Error("dsh-plugin-user-override"); }
  if (url.protocol !== "file:" || !url.pathname.endsWith("/deepseek-harness/index.mjs")) throw new Error("dsh-plugin-user-override");
  const remaining = body.slice(row[0].length);
  // An indented continuation could change the owned insert or plugin. Retain
  // the whole file rather than guessing how to remove part of an unknown row.
  const first = remaining.split(/\r?\n/).find(line => line.trim() && !/^\s*#/.test(line));
  if (first && !/^- /.test(first)) throw new Error("dsh-plugin-user-override");
  return text.slice(0, start) + remaining + text.slice(end + END.length).replace(/^\r?\n/, "");
}

class DshIntegration {
  constructor({ homeDir, root, assetRoot, backup, write }) {
    this.root = root || path.join(homeDir, ".dsh");
    this.target = path.join(homeDir, ".vibe-halo", "integrations", "deepseek-harness");
    this.assetRoot = path.join(assetRoot, "deepseek-harness");
    this.backup = backup;
    this.write = write;
  }
  profiles() {
    const dir = path.join(this.root, "profiles");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(item.name) && item.name !== "node_modules")
      .map(item => path.join(dir, item.name))
      .filter(dir => fs.existsSync(path.join(dir, "package.json")));
  }
  block() {
    return `${START}\n- insert:\n    - id: ${ID}\n      name: ${JSON.stringify(pathToFileURL(path.join(this.target, "index.mjs")).href)}\n${END}\n`;
  }
  inspect(dir) {
    const file = path.join(dir, "cordis.patch.yml");
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("dsh-patch-symlink");
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text.length > 1024 * 1024) throw new Error("dsh-patch-too-large");
    const base = withoutBlock(text);
    // Any separately owned override of our ID is authoritative (including disable
    // patches). Do not guess YAML semantics or shadow an explicit user choice.
    if (base.includes(ID) || base.includes("deepseek-harness/index.mjs")) throw new Error("dsh-plugin-user-override");
    return { file, text, base };
  }
  status() {
    const dirs = this.profiles();
    if (!dirs.length) return { detected: fs.existsSync(this.root), installed: false, healthy: false, disabled: false, reason: "dsh-profile-missing" };
    let installed = false;
    try {
      const values = dirs.map(dir => this.inspect(dir));
      installed = values.some(v => v.text.includes(START));
      const assets = ["index.mjs", "package.json"].every(name => fs.existsSync(path.join(this.target, name))
        && lf(fs.readFileSync(path.join(this.target, name), "utf8")) === lf(fs.readFileSync(path.join(this.assetRoot, name), "utf8")));
      const healthy = assets && values.every(v => lf(v.text).includes(this.block()));
      return { detected: true, installed, healthy, disabled: false, reason: healthy ? "healthy" : "dsh-restart-or-repair-required" };
    } catch (error) {
      return { detected: true, installed, healthy: false, disabled: error.message === "dsh-plugin-user-override", reason: error.message };
    }
  }
  install() {
    const dirs = this.profiles();
    if (!dirs.length) return { ok: false, reason: "dsh-profile-missing" };
    // Preflight every profile before writing any of them.
    const values = dirs.map(dir => this.inspect(dir));
    for (const { base } of values) {
      const empty = base.replace(/^\s*#.*$/gm, "").trim();
      if (empty && empty !== "[]" && !/^\s*-\s/m.test(base)) throw new Error("unsupported-dsh-patch-root");
    }
    for (const name of ["index.mjs", "package.json"]) {
      if (!fs.existsSync(path.join(this.assetRoot, name))) return { ok: false, reason: "integration-asset-missing" };
    }
    let changed = false;
    for (const name of ["index.mjs", "package.json"]) {
      const content = fs.readFileSync(path.join(this.assetRoot, name), "utf8");
      const target = path.join(this.target, name);
      if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) { this.write(target, content); changed = true; }
    }
    for (const { file, text, base } of values) {
      // Empty YAML array documents cannot be followed by sequence entries.
      const empty = base.replace(/^\s*#.*$/gm, "").trim();
      const clean = empty === "[]" ? base.replace(/^\s*\[\]\s*$/m, "") : base;
      if (empty && empty !== "[]" && !/^\s*-\s/m.test(clean)) throw new Error("unsupported-dsh-patch-root");
      const next = `${clean.trimEnd()}${clean.trim() ? "\n\n" : ""}${this.block()}`;
      if (next !== text) { this.backup(file); this.write(file, next); changed = true; }
    }
    return { ok: true, changed, paths: values.map(v => v.file), reason: changed ? "dsh-restart-required" : null };
  }
  uninstall() {
    for (const dir of this.profiles()) {
      const file = path.join(dir, "cordis.patch.yml");
      if (!fs.existsSync(file)) continue;
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("dsh-patch-symlink");
      const text = fs.readFileSync(file, "utf8");
      const next = withoutBlock(text);
      if (next !== text) this.write(file, next.trim() ? next : "[]\n");
    }
    // Keep the inert assets: a still-running DSH may be importing them while it
    // shuts down. Only owned profile rows are removed; third-party rows stay.
    return { ok: true, reason: "dsh-restart-required" };
  }
}

module.exports = { DshIntegration, withoutBlock };
