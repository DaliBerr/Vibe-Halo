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
  asar: true,
  asarUnpack: ["hooks/**/*"],
  files: [
    "src/**/*",
    "hooks/**/*",
    "LICENSE",
    "NOTICE.md",
    "README.md",
    "README.zh-CN.md",
  ],
  extraMetadata: {
    autoUpdateEnabled: Boolean(publisherName),
    desktopName: "com.vibe.halo",
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
    artifactName: "Vibe-Halo-Setup-${version}-${arch}.${ext}",
    icon: "build/icon.png",
    verifyUpdateCodeSignature: true,
    signtoolOptions,
  },
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    artifactName: "Vibe-Halo-${version}-${arch}.${ext}",
    category: "public.app-category.utilities",
    icon: "build/icon.png",
    minimumSystemVersion: "12.0",
    // Ad-hoc signing keeps Apple Silicon bundles launchable after packaging.
    // It is not a trusted Developer ID signature and does not enable updates.
    identity: "-",
    hardenedRuntime: false,
    notarize: false,
    extendInfo: { LSUIElement: true },
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    artifactName: "Vibe-Halo-${version}-x64.${ext}",
    category: "Utility",
    synopsis: "Approval and notification island for AI coding agents",
    description: "Vibe Halo presents supported AI coding agent approvals, questions, and completion notifications in a top-center island.",
    maintainer: "DaliBerr <DaliBerr@users.noreply.github.com>",
    vendor: "Vibe Halo contributors",
    executableName: "vibe-halo",
    syncDesktopName: true,
    icon: "build/generated-icons",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    multiLanguageInstaller: true,
    installerLanguages: ["en_US", "zh_CN"],
    displayLanguageSelector: false,
    include: "build/installer.nsh",
  },
};
