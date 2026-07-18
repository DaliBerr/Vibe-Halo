"use strict";

const path = require("path");

const publisherName = (process.env.VIBE_HALO_PUBLISHER_NAME || "").trim();
const externalSigning = process.env.VIBE_HALO_EXTERNAL_SIGNING === "1";

const signtoolOptions = {
  signingHashAlgorithms: ["sha256"],
  ...(publisherName ? { publisherName } : {}),
  ...(externalSigning ? { sign: path.join(__dirname, "scripts", "stage-windows-signing.js") } : {}),
};

module.exports = {
  appId: "com.vibe.halo",
  productName: "Vibe Halo",
  artifactName: "Vibe-Halo-Setup-${version}-${arch}.${ext}",
  asar: true,
  asarUnpack: ["hooks/**/*"],
  files: [
    "src/**/*",
    "hooks/**/*",
    "LICENSE",
    "NOTICE.md",
    "README.md",
  ],
  extraMetadata: {
    autoUpdateEnabled: Boolean(publisherName),
  },
  electronUpdaterCompatibility: ">=6.0.0",
  publish: [{
    provider: "github",
    owner: "DaliBerr",
    repo: "Vibe-Halo",
    channel: "latest",
    releaseType: "release",
  }],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    verifyUpdateCodeSignature: true,
    signtoolOptions,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    include: "build/installer.nsh",
  },
};
