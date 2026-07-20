"use strict";

const fs = require("fs");
const path = require("path");

function cleanPublisher(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= 240
    && !/[\r\n\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : "";
}

function updateConfig(publisherName) {
  const publisher = cleanPublisher(publisherName);
  if (typeof publisherName === "string" && publisherName.length > 0 && !publisher) {
    throw new Error("Publisher name must be bounded and single-line");
  }
  return [
    "provider: github",
    "owner: DaliBerr",
    "repo: Vibe-Halo",
    "channel: latest",
    "updaterCacheDirName: vibe-halo-updater",
    ...(publisher ? ["publisherName:", `  - ${JSON.stringify(publisher)}`] : []),
    "",
  ].join("\n");
}

function writeConfig(appDir, publisherName) {
  const root = path.resolve(appDir || "");
  const executable = path.join(root, "Vibe Halo.exe");
  if (!fs.existsSync(executable)) throw new Error("Prepackaged Vibe Halo application is missing");
  const target = path.join(root, "resources", "app-update.yml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, updateConfig(publisherName), "utf8");
  fs.renameSync(temp, target);
  return target;
}

if (require.main === module) {
  try {
    const target = writeConfig(process.argv[2], process.argv[3] || "");
    process.stdout.write(`${target}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { cleanPublisher, updateConfig, writeConfig };
