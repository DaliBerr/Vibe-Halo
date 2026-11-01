"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function generate({ apk, versionName, versionCode, sourceCommit, outDir }) {
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(versionName || "")) throw new Error("Invalid Android version name");
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2147483647) throw new Error("Invalid Android version code");
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) throw new Error("A full source commit SHA is required");
  const apkName = `Vibe-Halo-Mobile-${versionName}.apk`;
  if (path.basename(apk || "") !== apkName) throw new Error("APK filename does not match version");
  const size = fs.statSync(apk).size;
  if (size < 1 || size > 64 * 1024 * 1024) throw new Error("APK size is outside update limits");
  const metadata = {
    schema: 1, packageName: "com.vibe.halo.mobile", versionName, versionCode, apkName,
    size, sha256: crypto.createHash("sha256").update(fs.readFileSync(apk)).digest("hex"), sourceCommit,
  };
  const output = path.join(outDir || path.dirname(apk), "android-update.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, output);
  return { output, ...metadata };
}

if (require.main === module) {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!process.argv[index].startsWith("--") || process.argv[index + 1] == null) throw new Error("Expected --name value arguments");
    args[process.argv[index].slice(2)] = process.argv[index + 1];
  }
  console.log(JSON.stringify(generate({ apk: args.apk, versionName: args["version-name"], versionCode: Number(args["version-code"]), sourceCommit: args["source-commit"], outDir: args["out-dir"] })));
}

module.exports = { generate };
