"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");

function argumentsFrom(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`Invalid argument: ${key || "missing"}`);
    output[key.slice(2)] = value;
  }
  return output;
}

function validVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function hashFile(filePath, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest(encoding)));
  });
}

function yamlUpdateInfo({ version, fileName, sha512, size, releaseDate }) {
  return [
    `version: ${JSON.stringify(version)}`,
    "files:",
    `  - url: ${JSON.stringify(fileName)}`,
    `    sha512: ${JSON.stringify(sha512)}`,
    `    size: ${size}`,
    `path: ${JSON.stringify(fileName)}`,
    `sha512: ${JSON.stringify(sha512)}`,
    `releaseDate: ${JSON.stringify(releaseDate)}`,
    "",
  ].join("\n");
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, filePath);
}

async function generate(options) {
  const installer = path.resolve(options.installer || "");
  const version = options.version;
  const outDir = path.resolve(options["out-dir"] || path.dirname(installer));
  if (!fs.existsSync(installer) || !fs.statSync(installer).isFile()) throw new Error("Signed installer is missing");
  if (!validVersion(version)) throw new Error("A valid --version is required");

  const fileName = path.basename(installer);
  if (/\r|\n/.test(fileName)) throw new Error("Installer filename is invalid");
  const blockMapPath = path.join(outDir, `${fileName}.blockmap`);
  const updateInfo = await buildBlockMap(installer, "gzip", blockMapPath);
  const releaseDate = process.env.VIBE_HALO_RELEASE_DATE || new Date().toISOString();
  if (!Number.isFinite(Date.parse(releaseDate))) throw new Error("VIBE_HALO_RELEASE_DATE must be an ISO date");
  const latestPath = path.join(outDir, "latest.yml");
  atomicWrite(latestPath, yamlUpdateInfo({
    version,
    fileName,
    sha512: updateInfo.sha512,
    size: updateInfo.size,
    releaseDate,
  }));

  const checksumTargets = [installer, blockMapPath, latestPath];
  const checksums = [];
  for (const target of checksumTargets) {
    checksums.push(`${await hashFile(target, "sha256", "hex")}  ${path.basename(target)}`);
  }
  const checksumsPath = path.join(outDir, "SHA256SUMS.txt");
  atomicWrite(checksumsPath, `${checksums.join("\n")}\n`);
  return { blockMapPath, checksumsPath, latestPath, sha512: updateInfo.sha512, size: updateInfo.size };
}

if (require.main === module) {
  generate(argumentsFrom(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { argumentsFrom, generate, hashFile, validVersion, yamlUpdateInfo };
