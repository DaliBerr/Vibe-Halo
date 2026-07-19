# Vibe Halo signed releases

Vibe Halo uses GitHub Releases and electron-builder for Windows, macOS, and Linux previews. The stable update channel remains Windows-only and uses `electron-updater`, x64 NSIS, and SignPath Foundation. Unsigned and local builds deliberately contain `autoUpdateEnabled: false`; only a Windows release build with the certificate's exact publisher name enables update checks.

## Three-platform preview procedure

1. Keep `package.json`, `package-lock.json`, both READMEs, and `HANDOFF.md` on the same version.
2. Push the release branch and wait for `.github/workflows/cross-platform.yml` to pass on Windows 2025, macOS 15 arm64/Intel, Ubuntu 22.04, and Ubuntu 24.04.
3. Merge the exact verified commit to `main`, create `preview-<version>`, and push it.
4. The workflow builds Windows x64 NSIS, macOS arm64/x64 DMG and ZIP, and Linux x64 AppImage/deb. It publishes an unsigned GitHub Pre-release with `SHA256SUMS.txt`.
5. Do not upload `latest.yml`, `latest-mac.yml`, Linux update metadata, or mark the preview as latest. macOS/Linux automatic updates remain disabled until a signed and notarized production path exists.

macOS preview packages are intentionally unsigned and unnotarized. Linux support is guaranteed only for Ubuntu 22.04/24.04 and Debian 12 x64 in the initial release; other AppImage-compatible distributions are best effort.

## SignPath Foundation application

The maintainer must submit and accept the application at <https://signpath.org/apply>. Use these project details:

- Project: Vibe Halo
- Repository: <https://github.com/DaliBerr/Vibe-Halo>
- License: AGPL-3.0-only
- Artifact: Windows x64 Electron application distributed as an NSIS EXE
- Signing requirement: the application executable, bundled NSIS elevation helper, generated NSIS uninstaller, and final NSIS installer
- Build system: GitHub-hosted Windows runner with GitHub origin verification
- Update transport: public GitHub Releases, stable `latest` channel

Before applying, the repository must be public and the complete Git history must pass a dedicated secret scan. Do not rewrite history or publish the repository when a real credential is found without first coordinating its revocation and cleanup.

## SignPath project configuration

Install the SignPath GitHub App, link the repository as a trusted build system, and restrict the release signing policy to `main`. The artifact configuration receives exactly one PE file in each GitHub artifact:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="*.exe" max-matches="unbounded">
      <authenticode-sign hash-algorithm="sha256" />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

Configure the following GitHub repository variables:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_PUBLISHER_NAME` — the exact full certificate Subject distinguished name returned by Authenticode, not only its common name

Configure `SIGNPATH_API_TOKEN` as a GitHub Actions secret. Never place the token in source, release assets, build logs, or application metadata.

## Release procedure

1. Update `package.json`, `package-lock.json`, `HANDOFF.md`, and release notes to the same stable semantic version.
2. Run `npm ci`, `npm test`, `npm run build:dir`, and `npm run build` locally. Local packages are expected to remain unsigned and auto-update-disabled.
3. Merge the verified release commit into `main` and create a `v<version>` tag on that exact commit.
4. Push the tag. The release workflow verifies that the tag matches `package.json` and belongs to `main`.
5. The workflow signs the application EXE and NSIS elevation helper, injects a signed uninstaller, signs the final installer, regenerates blockmap and update metadata, validates the installed package, and only then publishes the draft Release.

Version 0.3.0 is the one-time bootstrap release because 0.2.3 has no updater. After installing signed 0.3.0 manually, publish signed 0.3.1 and verify background download, explicit restart, fail-open approval shutdown, relaunch, and final version before treating automatic updates as production-verified.
