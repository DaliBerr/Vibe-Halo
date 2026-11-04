"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IntegrationManager } = require("../src/integration-manager");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-dsh-profile-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, ".dsh", "profiles", "desktop");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), "{}");
  const manager = new IntegrationManager({ homeDir: home, hookScriptPath: __filename });
  assert.equal(manager.install("deepseek-harness").ok, true);
  return { manager, file: path.join(profile, "cordis.patch.yml") };
}

test("DSH native YAML rewrites preserve unrelated patches inside the trailing marker", t => {
  const { manager, file } = fixture(t);
  const foreign = "- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: unrelated-disabled\n  disabled: true\n- id: custom-expression\n  config: !!js process.env.EXAMPLE\n";
  const rewritten = fs.readFileSync(file, "utf8")
    .replace('index.mjs"', 'index.mj\\\n        s"')
    .replace("# <<< Vibe Halo", `${foreign}# <<< Vibe Halo`);
  fs.writeFileSync(file, rewritten);
  assert.equal(manager.install("deepseek-harness").ok, true);
  const repaired = fs.readFileSync(file, "utf8");
  assert.ok(repaired.includes(foreign));
  assert.ok(repaired.indexOf(foreign) < repaired.indexOf("# >>> Vibe Halo"));
  assert.equal(manager.status("deepseek-harness").healthy, true);
  manager.uninstall("deepseek-harness");
  assert.ok(fs.readFileSync(file, "utf8").includes(foreign));
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /vibe-halo-dsh|Vibe Halo integration/);
});

test("DSH ambiguous changes to the owned insert remain untouched on repair and removal", t => {
  const { manager, file } = fixture(t);
  const changed = fs.readFileSync(file, "utf8").replace("# <<< Vibe Halo", "# User customization\n      config:\n        custom: true\n# <<< Vibe Halo");
  fs.writeFileSync(file, changed);
  assert.throws(() => manager.install("deepseek-harness"), /user-override/);
  assert.equal(fs.readFileSync(file, "utf8"), changed);
  assert.throws(() => manager.uninstall("deepseek-harness"), /user-override/);
  assert.equal(fs.readFileSync(file, "utf8"), changed);
});

test("DSH health accepts equivalent LF and CRLF text assets and profile rows", t => {
  const { manager, file } = fixture(t);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n"));
  for (const name of ["index.mjs", "package.json"]) {
    const target = path.join(manager.dsh.target, name);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n"));
  }
  assert.equal(manager.status("deepseek-harness").healthy, true);
});
