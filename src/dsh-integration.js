"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const START = "# >>> Vibe Halo integration (deepseek-harness) >>>";
const END = "# <<< Vibe Halo integration (deepseek-harness) <<<";
const ID = "vibe-halo-dsh";

function withoutBlock(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return text;
  if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0
    || text.indexOf(END, end + END.length) >= 0) throw new Error("invalid-dsh-managed-block");
  return text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, "");
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
    const owned = text.slice(text.indexOf(START), text.indexOf(END));
    if (/\b(?:disabled:\s*true|enabled:\s*false)\b/.test(owned)) throw new Error("dsh-plugin-user-override");
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
        && fs.readFileSync(path.join(this.target, name)).equals(fs.readFileSync(path.join(this.assetRoot, name))));
      const healthy = assets && values.every(v => v.text.includes(this.block()));
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
