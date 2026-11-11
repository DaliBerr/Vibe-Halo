# Vibe Halo stable releases

Vibe Halo publishes Windows x64 only, through GitHub Releases and `electron-builder`. The stable update channel and uses `electron-updater` with NSIS, `latest.yml`, blockmaps, and SHA-512 integrity metadata. Official stable builds opt into updates with `VIBE_HALO_AUTO_UPDATE=1`; source, local, and preview builds remain update-disabled.

The default stable workflow is unsigned. It accepts the Windows unknown-publisher/SmartScreen tradeoff and does not provide a publisher-identity guarantee. The retained SignPath route is an optional enhancement activated only when the repository variable `VIBE_HALO_SIGNPATH_ENABLED` is exactly `1`.

## Continuous integration

Only `.github/workflows/release.yml` runs automatically, when a `v<version>` tag is pushed. macOS/Linux packages are no longer built or published (the last preview was `preview-0.6.3`). `.github/workflows/mobile-companion.yml` (relay, protocol and Android checks) runs only on manual dispatch; run it before shipping Android or relay changes.

## Default unsigned Windows stable release

Leave `VIBE_HALO_SIGNPATH_ENABLED` absent or set it to `0`. A `v<version>` tag on `main` triggers the stable workflow, which:

1. Validates that the tag matches `package.json` and points to a commit on `main`.
2. Sets `VIBE_HALO_AUTO_UPDATE=1`, builds the unpacked app, and writes an `app-update.yml` for the public GitHub `latest` channel without `publisherName`.
3. Builds the final unsigned NSIS installer and regenerates its blockmap, `latest.yml`, and `SHA256SUMS.txt` from the final bytes.
4. Verifies the packaged updater gate and configuration, performs a silent install/uninstall smoke test, and publishes a non-draft, non-prerelease Latest Release.

Version `0.5.5` is the one-time manually installed bootstrap release; the immutable `v0.5.4` tag failed validation before publication. Version `0.5.6` completed the first live N-to-N+1 automatic-update acceptance. Do not move or replace a published tag. If a tagged release fails, fix the workflow and increment the application version.

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
2. Run `npm ci`, `npm test`, normal package verification and an NSIS build locally.
3. Merge the verified release commit into `main` and create `v<version>` on that exact commit.
4. Push the tag and monitor `.github/workflows/release.yml` through publication.
5. Confirm that the Release is Latest, non-draft, non-prerelease, and includes the installer, blockmap, `latest.yml`, `SHA256SUMS.txt`, `LICENSE`, and `NOTICE.md`.

## Android companion assets

Keep Android `versionName` aligned with the desktop release and increment
`versionCode` for every distributed Android update. Build the release variant
with the intended Firebase client configuration, then sign it with the retained
release keystore. Never commit the keystore, passwords or service-account keys.
Verify the signing certificate against the previous APK before publication;
changing the key or application ID prevents a normal upgrade preserving pairing.

An authorized Android-only follow-up can add the aligned Android version to an
existing desktop release without moving its tag or rebuilding Windows. Keep the
full committed Android source SHA in the manifest and Android release notes when
it differs from the original desktop tag, and preserve all existing Windows
assets. Verify the newly published APK/manifest and the unchanged desktop asset
IDs and digests before declaring the update available.

The mobile CI validates builds and lint; its unsigned/debug APKs are not the
public download. Attach the locally verified, original-key-signed
`Vibe-Halo-Mobile-<version>.apk` to the stable tag's release, clearly labeled as
an Android preview. Publish its SHA-256 checksum alongside the existing desktop
checksums without changing `latest.yml` or the installer blockmap. Keep remaining
physical-device checks explicit in the release notes.

### Android in-app update metadata

After signing and verifying the APK, generate `android-update.json` with
`scripts/generate-android-update-metadata.js`. Pass `--apk`, `--version-name`,
`--version-code`, and the full committed Android source SHA via `--source-commit`.
The script binds the expected public filename, package ID, build code, byte size,
SHA-256 and source commit. It writes beside the APK, or under `--out-dir`.
Upload the APK and this manifest to the same stable release, then update
`SHA256SUMS.txt` to include both. Preserve existing Windows checksums and update
metadata. The application scans up to 20 stable releases and skips releases that
have no Android manifest; GitHub's asset digests, the manifest and the APK must
agree before an update can be offered and installed.

The Devices page offers explicit check, download and install actions. APKs are
bounded to 64 MiB and checked again against their metadata, installed package,
newer versionCode and current signing certificates before a read-only FileProvider
URI is passed to Android's installer. The initial source permission and each
installation require Android confirmation. Updates never use companion traffic,
pairing credentials, approvals, or remote control.

Published tags remain immutable. If the owner explicitly requests replacing an
Android asset under an existing visible version, increment Android versionCode,
retain versionName and the signing key, and record the new source commit in the
manifest and release notes. Replace only the Android assets and their checksum
entries; verify that the existing Windows assets remain byte-identical. The
0.6.6 replacement uses versionCode 7; its original desktop tag remains unchanged.
