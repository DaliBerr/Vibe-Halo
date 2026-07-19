"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadBuildConfig(environment = {}) {
  const file = path.join(__dirname, "..", "electron-builder.config.cjs");
  const previous = {
    VIBE_HALO_PUBLISHER_NAME: process.env.VIBE_HALO_PUBLISHER_NAME,
    VIBE_HALO_EXTERNAL_SIGNING: process.env.VIBE_HALO_EXTERNAL_SIGNING,
  };
  for (const name of Object.keys(previous)) delete process.env[name];
  Object.assign(process.env, environment);
  delete require.cache[require.resolve(file)];
  const config = require(file);
  for (const [name, value] of Object.entries(previous)) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  delete require.cache[require.resolve(file)];
  return config;
}

test("ordinary packages stay update-disabled while signed release packages are pinned to GitHub", () => {
  const local = loadBuildConfig();
  assert.equal(local.extraMetadata.autoUpdateEnabled, false);
  assert.equal(local.win.signtoolOptions.publisherName, undefined);
  assert.deepEqual(local.publish, [{
    provider: "github", owner: "DaliBerr", repo: "Vibe-Halo", channel: "latest", releaseType: "release",
  }]);
  assert.equal(local.nsis.multiLanguageInstaller, true);
  assert.deepEqual(local.nsis.installerLanguages, ["en_US", "zh_CN"]);
  assert.equal(local.nsis.displayLanguageSelector, false);

  const release = loadBuildConfig({
    VIBE_HALO_PUBLISHER_NAME: "CN=SignPath Foundation, O=SignPath Foundation",
    VIBE_HALO_EXTERNAL_SIGNING: "1",
  });
  assert.equal(release.extraMetadata.autoUpdateEnabled, true);
  assert.equal(release.win.signtoolOptions.publisherName, "CN=SignPath Foundation, O=SignPath Foundation");
  assert.match(release.win.signtoolOptions.sign, /stage-windows-signing\.js$/);
  assert.deepEqual(release.win.signtoolOptions.signingHashAlgorithms, ["sha256"]);
});

test("release workflow signs all PE layers before publishing update metadata", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.equal((workflow.match(/signpath\/github-action-submit-signing-request@v2/g) || []).length, 3);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.ok(workflow.indexOf("Sign installer") < workflow.indexOf("Generate signed update metadata"));
  assert.ok(workflow.indexOf("Verify signed package") < workflow.indexOf("Publish draft release assets"));
  assert.doesNotMatch(workflow, /IsNullOrWhiteSpace\("\$\{\{ secrets\./);
  assert.match(workflow, /gh release edit .*--draft=false --latest/);
});
