# Vibe Halo stable releases

Vibe Halo uses GitHub Releases and `electron-builder` for Windows, macOS, and Linux previews. The stable update channel remains Windows x64 only and uses `electron-updater` with NSIS, `latest.yml`, blockmaps, and SHA-512 integrity metadata. Official stable builds opt into updates with `VIBE_HALO_AUTO_UPDATE=1`; source, local, and preview builds remain update-disabled.

The default stable workflow is unsigned. It accepts the Windows unknown-publisher/SmartScreen tradeoff and does not provide a publisher-identity guarantee. The retained SignPath route is an optional enhancement activated only when the repository variable `VIBE_HALO_SIGNPATH_ENABLED` is exactly `1`.

## Three-platform preview procedure

1. Keep `package.json`, `package-lock.json`, both READMEs, and `HANDOFF.md` on the same version.
2. Push the release branch and wait for `.github/workflows/cross-platform.yml` to pass on Windows 2025, macOS 15 arm64/Intel, Ubuntu 22.04, and Ubuntu 24.04.
3. Merge the exact verified commit to `main`, create `preview-<version>`, and push it.
4. The workflow builds Windows x64 NSIS, macOS arm64/x64 DMG and ZIP, and Linux x64 AppImage/deb. It publishes a GitHub Pre-release with `SHA256SUMS.txt`; macOS packages carry only an ad-hoc signature.
5. Do not upload `latest.yml`, `latest-mac.yml`, Linux update metadata, or mark the preview as latest. Every preview package must contain `autoUpdateEnabled: false`.

macOS preview packages are ad-hoc signed for reliable Apple Silicon launch, but are not Developer ID signed or notarized. Linux support is guaranteed only for Ubuntu 22.04/24.04 and Debian 12 x64 in the initial release; other AppImage-compatible distributions are best effort.

## Default unsigned Windows stable release

Leave `VIBE_HALO_SIGNPATH_ENABLED` absent or set it to `0`. A `v<version>` tag on `main` triggers the stable workflow, which:

1. Validates that the tag matches `package.json` and points to a commit on `main`.
2. Sets `VIBE_HALO_AUTO_UPDATE=1`, builds the unpacked app, and writes an `app-update.yml` for the public GitHub `latest` channel without `publisherName`.
3. Builds the final unsigned NSIS installer and regenerates its blockmap, `latest.yml`, and `SHA256SUMS.txt` from the final bytes.
4. Verifies the packaged updater gate and configuration, performs a silent install/uninstall smoke test, and publishes a non-draft, non-prerelease Latest Release.

Version `0.5.4` is the one-time bootstrap release. Install it manually; automatic updating can first be proven when a later stable version is published. Do not move or replace a published tag. If a tagged release fails, fix the workflow and increment the application version.

## Optional SignPath route

The SignPath code path remains available but is disabled by default. To activate it, set the protected repository variable `VIBE_HALO_SIGNPATH_ENABLED=1`, install the SignPath GitHub App, link the repository as a trusted build system, and restrict the release signing policy to `main`. The artifact configuration receives exactly one PE file in each GitHub artifact:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="*.exe" max-matches="unbounded">
      <authenticode-sign hash-algorithm="sha256" />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

Configure these repository variables:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_PUBLISHER_NAME` — the exact full certificate Subject distinguished name

Configure `SIGNPATH_API_TOKEN` as a GitHub Actions secret. Never place the token in source, release assets, build logs, or application metadata. When enabled, the workflow signs the application EXE and NSIS elevation helper, injects a signed uninstaller, signs the final installer, verifies every publisher Subject, and then runs the same common metadata, installation, and publication stages.

## Release checklist

1. Update `package.json`, `package-lock.json`, `HANDOFF.md`, both READMEs, and release notes to the same stable semantic version.
2. Run `npm ci`, `npm test`, normal package verification, an update-enabled Windows package verification, and an NSIS build locally.
3. Merge the verified release commit into `main` and create `v<version>` on that exact commit.
4. Push the tag and monitor `.github/workflows/release.yml` through publication.
5. Confirm that the Release is Latest, non-draft, non-prerelease, and includes the installer, blockmap, `latest.yml`, `SHA256SUMS.txt`, `LICENSE`, and `NOTICE.md`.
