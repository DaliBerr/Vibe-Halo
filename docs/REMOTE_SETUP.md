# Android companion: build, deploy and connect

The desktop and Android sources implement an optional companion. A fresh desktop
installation has both remote access and remote control disabled. There is no
bundled public relay or Firebase project. Dated acceptance evidence and remaining
device checks are in [HANDOFF.md](../HANDOFF.md); the [protocol](REMOTE_PROTOCOL.md)
and [product decisions](REMOTE_DECISIONS.md) define the security boundary.

## Local build

Use Node 24, JDK 21, Android SDK 36 and build-tools 35.0.0. Open `apps/android` in
Android Studio, or set `JAVA_HOME` and `ANDROID_HOME` in your shell. The Gradle
wrapper includes its distribution SHA-256 checksum. Do not commit `local.properties`.

```sh
# repository root
npm ci
npm test
npm run test:protocol
npm run build:dir
npm run verify:package -- dist/win-unpacked/resources 0.5.9

cd services/relay
npm ci
npm run check
npm test
npm run build                    # dry-run only; does not deploy

cd ../../apps/android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest :app:assembleRelease :app:lintDebug :app:lintRelease
```

On Windows use `gradlew.bat`. The debug APK is
`apps/android/app/build/outputs/apk/debug/app-debug.apk`, application ID
`com.vibe.halo.mobile.debug`. The minified release APK is unsigned until the
maintainer supplies a signing key. Do not distribute a release signed with the
debug key. The release ID is `com.vibe.halo.mobile`; configure the matching
Firebase Android application for each build ID. Minimum Android version is 8.0
(API 26). Google services are required for FCM, but not foreground LAN reads.

For side-loading the release, sign the unsigned APK with a dedicated retained
keystore using Android SDK `apksigner sign`, and verify it with `apksigner verify
--verbose --print-certs`. Pass passwords through private process environment or
stdin, not literal command arguments. Retain the key and its password for future
updates; a new key cannot update an existing installation. No Play upload or
desktop release tag is required for this locally signed APK.

No Firebase properties means a usable foreground-only test build. The Devices
page explicitly reports that push is not configured. A local Worker can be used
with `npm run migrate:local` and `npm run dev`; copy `.dev.vars.example` to ignored
`.dev.vars` and generate fresh local-only keys. Only debug Android builds and the
explicit desktop synthetic harness accept loopback HTTP. Release builds require
HTTPS; never expose the debug Worker or synthetic bridge to a public interface.

## Deploy your relay

1. Authenticate Wrangler locally (`npx wrangler login`) or provision a narrowly
   scoped Cloudflare API token through the process environment. Credentials are
   not app-user accounts and must not be put in Git, chat or screenshots.
2. Run `npx wrangler d1 create vibe-halo-relay`. Put the returned database ID into
   `services/relay/wrangler.jsonc`, replacing its deliberately invalid placeholder.
   To keep the portable template unchanged, copy it to the ignored sibling
   `wrangler.production.jsonc` and pass `--config wrangler.production.jsonc` to
   all production Wrangler commands and `scripts/admin.mjs` commands instead.
3. Set `RELAY_ORIGIN` to the exact HTTPS origin, with no path/query/fragment. Add
   your custom-domain route, or intentionally enable `workers_dev` and use its
   exact HTTPS origin. All devices and signed handshakes must use that origin.
4. Provision independent random `ENROLLMENT_PEPPER`, `PAIRING_PEPPER`, and
   `PUSH_TOKEN_KEY` with `npx wrangler secret put NAME`. The first two must contain
   at least 32 random characters; the last is base64 of exactly 32 random bytes.
   Do not rotate peppers while enrollment/pairing transactions are in flight.
   Push-key rotation invalidates old encrypted push tokens and requires token
   registration again; it does not replace device identities.
5. Run `npx wrangler d1 migrations apply vibe-halo-relay --remote`, then
   `npx wrangler deploy`. SQLite Durable Objects migration `v1` is included.
   Check `/healthz` and inspect the deployment in Cloudflare before pairing.
6. Generate one controlled PC enrollment code. Supply the same enrollment pepper
   securely in the shell environment, then run:

   ```sh
   node scripts/admin.mjs enrollment-code --remote --out /private/path/pc-code.txt
   ```

   The script creates the file exclusively, never prints the code, and inserts
   only its HMAC and expiry into D1. The code expires in 30 minutes and can enroll
   one PC. Local testing uses `--local` and the ignored `.dev.vars` pepper.

Default capacity is 10 active PCs and 6 active phones per PC. Keep these limits
small on free infrastructure. Use the Cloudflare dashboard to check D1 rows,
Worker CPU, DO storage/duration, requests and logs before increasing them. The
application does not change plans or buy capacity. API and WebSocket rate limits,
24-hour journals, bounded retry queues and hourly cleanup bound common abuse, but
are not a promise that every workload fits a free allowance. Public production
CPU and hibernation billing require deployment measurement.

For a synthetic public-relay emulator run, issue a fresh enrollment code to a
private file, then run `scripts/mobile-smoke-host.cjs` from the repository root
with `VIBE_HALO_TEST=1`, `VIBE_HALO_SMOKE_RELAY_ORIGIN` set to the exact deployed
HTTPS origin and `VIBE_HALO_SMOKE_ENROLLMENT_FILE` pointing to that file. This
harness does not discover production credentials or generate public codes. It
uses an isolated synthetic PC with ephemeral test encryption and binds its
authenticated test bridge only to loopback. Forward bridge port 8788 and the
fixture's LAN port to the emulator; run `CompanionFlowTest` with the private
fixture copied to the debug app. The cloud leg now traverses the real Worker,
while the LAN leg still uses emulator forwarding. Revoke the synthetic PC with
`scripts/admin.mjs revoke-pc --remote --config wrangler.production.jsonc --pc ID`
afterwards. This does not test background FCM or physical multicast discovery.

## Configure FCM

Enable the Firebase Cloud Messaging HTTP v1 API in your own Google/Firebase
project. Configure a service identity allowed to send FCM messages. Keep its
private key only in the Worker secret `FCM_PRIVATE_KEY`; also set
`FCM_CLIENT_EMAIL` and `FCM_PROJECT_ID` as secrets. Set `FCM_ENABLED` to `true` in
the Worker configuration and deploy. The Worker exchanges a short RS256 assertion
for an OAuth service token; this is not a phone user-login flow.

Provide these public Android application values using private local Gradle
properties or CI configuration:

```properties
firebase.appId=YOUR_ANDROID_FIREBASE_APP_ID
firebase.apiKey=YOUR_ANDROID_APP_API_KEY
firebase.projectId=YOUR_PROJECT_ID
firebase.senderId=YOUR_NUMERIC_SENDER_ID
```

Rebuild the APK. No service-account JSON/private key belongs in the APK. These
public app values are different from server credentials. The code initializes
Firebase explicitly, so no `google-services.json` plugin is required. Do not
configure Analytics or notification-listener/accessibility permissions.

The first token and token rotations are stored encrypted. A bounded WorkManager
job retries registration with network availability, and opening the app also
retries pending token/preferences/revocation updates. This worker never polls
approvals or submits decisions. Android and the relay must reference the same
Firebase project. An unset configuration, API error, token rejection or permission
denial must not be reported as successful delivery.

`PublicPushSetupTest` is an explicit opt-in (`-e publicPush 1`) for a configured
debug APK and a private synthetic bridge fixture. It obtains a real FCM token,
pairs and registers it without logging it, then exits so a separate background
notification check can run outside instrumentation. It deliberately leaves the
test binding active; the caller must revoke that synthetic PC after the check.
Check the system notification record/visible notification, not only an HTTP 200.
FCM auto-displayed reminders use a different notification ID from foreground
reminders; terminal reconciliation cancels all active IDs with the event's tag.

## Connect and use

1. Open **Mobile companion / 手机伴侣** from the desktop tray. Enter the relay
   origin, PC name and one-time PC enrollment code; enable the companion.
2. Generate a pairing code. Choose read-only permissions, or permissions for
   decisions and exact answers. Persistent authorization is a separate opt-in.
3. On Android choose **Connect a computer**, enter the same relay origin and
   pairing code, and compare all three fingerprint groups on both devices.
4. Confirm the fingerprint on the PC, then explicitly finish pairing on the
   phone. A claim alone creates no trusted phone. Cancel or let an uncertain
   transaction expire; never confirm a mismatched fingerprint.
5. Enable the separate PC control switch if phone decisions are wanted. Only the
   current PC queue head offers actionable decisions. Original deadlines continue
   while a phone is asleep, disconnected or showing details.
6. Send the PC's test reminder and check the Android notification permission and
   relevant system channel. Notifications contain no approve/reject/reply action.
   Tap a notification to open and refresh its current detail. Persistent actions
   additionally show the full scope and require a second confirmation.

The app prefers authenticated LAN HTTPS/WSS with the PC's pinned TLS public key.
mDNS advertises only protocol version and PC ID. The independent LAN listener
does not move the Hook API off `127.0.0.1`. AP isolation, multicast filtering,
firewall rules or Android local-network permission can prevent discovery; the
foreground app falls back to the configured cloud relay. Do not open router ports
or expose the local Hook listener. Android background notifications use FCM even
on the same Wi-Fi; there is no permanent background socket/approval poller.

The Now page aggregates bound PCs while keeping their queues separate. History
includes recent remote events; **Load computer history** fetches the selected PC's
original read-only history. Closing an input reminder does not answer the client.
Closing a detail, swiping a notification or backgrounding the app does not make a
decision. `desktop_accepted` means the PC accepted the decision, not that the
coding client ran a command. A lost receipt is queried/retried with the same
decision ID; no new delayed approval is created automatically.

## Revoke, recover and roll back

Revoke a phone from its PC immediately to close local trust. A phone can remove a
single binding without removing its other PCs. Cloud revocation is retried after
an outage; the UI does not claim that a disconnected PC already learned it.
An administrator can revoke the entire PC domain with:

```sh
node scripts/admin.mjs revoke-pc --remote --pc pc_REPLACE_WITH_ACTUAL_ID
```

Root revocation closes cloud authority immediately; offline LAN retains the last
PC-local trust until the PC learns the revocation. For immediate local removal,
turn off remote access/control or revoke locally on that PC.

For a lost phone or Keystore failure: revoke its old binding on every PC, clear
the phone's app data and pair again. For a lost PC identity: revoke the old PC
domain, quit the desktop, preserve the damaged encrypted companion files for
diagnosis outside the active user-data directory, then enroll as a new PC and
pair each phone again. Do not restore another device's keys or accept a new key
solely because its device name matches. A corrupt store is not overwritten or
downgraded to plaintext automatically.

To disable the feature, use the desktop switch; existing Hook/native flows remain
available. To roll back binaries, disable remote access first, retain encrypted
identity and revocation records, and deploy only protocol-compatible database
migrations. Do not restore a pre-revocation database snapshot as an ordinary
rollback. Do not remove or reset existing desktop history/integration settings.

## Real-device acceptance

Test a synthetic request before any real command. Record phone model/Android/GMS,
watch model/system and companion-app notification settings. Check same Wi-Fi
foreground, Wi-Fi background/lock, cellular, denied notification permission,
blocked channels, Do Not Disturb, Doze, system process reclamation and force-stop
as distinct cases. Force-stop may prevent FCM until the app is opened again.
Verify that the watch displays a short Vibe Halo notification with no buttons,
and respects disabling notification mirroring for this app. Delayed background
FCM may still display an old reminder; opening it must show current read-only
state. Neither FCM acceptance nor a local `notify()` call proves the user/watch
actually saw a message.
