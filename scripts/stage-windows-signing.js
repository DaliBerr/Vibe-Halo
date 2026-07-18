"use strict";

const fs = require("fs");
const path = require("path");

function classifySigningTarget(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (name === "elevate.exe") return "elevate";
  if (name.endsWith("__uninstaller.exe")) return "uninstaller";
  if (name.endsWith(".exe") && name.includes("setup")) return "installer";
  return "unknown";
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, destination);
}

async function sign(configuration) {
  const target = classifySigningTarget(configuration?.path || "");
  if (target === "unknown") {
    throw new Error(`Unexpected external signing target: ${path.basename(configuration?.path || "missing")}`);
  }
  const stageDir = path.resolve(process.env.VIBE_HALO_SIGN_STAGE_DIR || "");
  if (!process.env.VIBE_HALO_SIGN_STAGE_DIR) throw new Error("VIBE_HALO_SIGN_STAGE_DIR is required");

  if (target === "uninstaller" && process.env.VIBE_HALO_SIGNED_UNINSTALLER) {
    const signedUninstaller = path.resolve(process.env.VIBE_HALO_SIGNED_UNINSTALLER);
    if (!fs.existsSync(signedUninstaller)) throw new Error("Signed uninstaller is missing");
    copyFile(signedUninstaller, configuration.path);
    return;
  }

  if (target === "elevate" && process.env.VIBE_HALO_SIGNED_ELEVATE) {
    const signedElevate = path.resolve(process.env.VIBE_HALO_SIGNED_ELEVATE);
    if (!fs.existsSync(signedElevate)) throw new Error("Signed elevate helper is missing");
    copyFile(signedElevate, configuration.path);
    return;
  }

  copyFile(configuration.path, path.join(stageDir, `${target}.exe`));
}

module.exports = { classifySigningTarget, copyFile, sign };
