"use strict";

const fs = require("fs");
const path = require("path");
const { SERVER_ID, RUNTIME_PATH } = require("./constants");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validateRuntime(value, options = {}) {
  if (!value || typeof value !== "object" || value.app !== SERVER_ID) return null;
  const port = Number(value.port);
  const ownerPid = Number(value.ownerPid);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (typeof value.token !== "string" || value.token.length < 32 || value.token.length > 256) return null;
  const alive = options.processAlive || processAlive;
  if (options.requireAlive !== false && !alive(ownerPid)) return null;
  return {
    app: SERVER_ID,
    port,
    ownerPid,
    token: value.token,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
  };
}

function readRuntime(options = {}) {
  const filePath = options.filePath || RUNTIME_PATH;
  try {
    return validateRuntime(JSON.parse(fs.readFileSync(filePath, "utf8")), options);
  } catch {
    return null;
  }
}

function writeRuntime(runtime, options = {}) {
  const filePath = options.filePath || RUNTIME_PATH;
  const safe = validateRuntime(runtime, { requireAlive: false });
  if (!safe) throw new Error("Invalid runtime identity");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  return safe;
}

function clearRuntime(ownerPid, options = {}) {
  const filePath = options.filePath || RUNTIME_PATH;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
  if (!Number.isInteger(ownerPid) || raw.ownerPid !== ownerPid || raw.app !== SERVER_ID) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { processAlive, validateRuntime, readRuntime, writeRuntime, clearRuntime };
