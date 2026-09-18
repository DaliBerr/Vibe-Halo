# Android companion: build, deploy and connect

The optional Android companion connects to a paired desktop over encrypted LAN
or cloud transport. The desktop automatically connects to the default public
relay; pairing and remote-control permissions still require explicit local
authorization. Published companion APKs include notification-only Firebase
configuration. Source/CI builds need their own Firebase configuration for FCM.
Dated acceptance evidence and remaining device checks are in
[HANDOFF.md](../HANDOFF.md); the [protocol](REMOTE_PROTOCOL.md) and
[product decisions](REMOTE_DECISIONS.md) define the security boundary.

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
npm run verify:package -- dist/win-unpacked/resources 0.6.0

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
4. Provision independent random `PAIRING_PEPPER` and
   `PUSH_TOKEN_KEY` with `npx wrangler secret put NAME`. The pairing pepper must contain
   at least 32 random characters; the last is base64 of exactly 32 random bytes.
   Do not rotate the pairing pepper while pairing transactions are in flight.
   Push-key rotation invalidates old encrypted push tokens and requires token
   registration again; it does not replace device identities.
5. Run `npx wrangler d1 migrations apply vibe-halo-relay --remote`, then
   `npx wrangler deploy`. SQLite Durable Objects migration `v1` is included.
   Check `/healthz` and inspect the deployment in Cloudflare before pairing.
6. The desktop and Android preview default to the deployed relay. No enrollment
   code or operator credentials are entered in the app. For self-hosting, set
   desktop process environment variable `VIBE_HALO_RELAY_ORIGIN` before first
   startup, and use Android's **Use a self-hosted service** option (or build with
   `-Prelay.origin=https://your-relay.example`). Existing device origins are preserved.

## Separate service administration

The operator CLI under `services/relay/scripts/admin.mjs` uses local Cloudflare
credentials. It is not included in desktop or Android packages. From
`services/relay`, using the exact production configuration:

```sh
node scripts/admin.mjs status --remote --config wrangler.production.jsonc
node scripts/admin.mjs close-registration --remote --config wrangler.production.jsonc
node scripts/admin.mjs open-registration --remote --config wrangler.production.jsonc
node scripts/admin.mjs revoke-pc --remote --config wrangler.production.jsonc --pc pc_DEVICE_ID
```

Apply migration `0002_self_service_registration.sql` before deploying this version.
It creates the registration switch, initially open. Closing it only blocks new
identities, not reconnecting registered devices. The old enrollment-code generator
is removed; historical code rows are unused and expire through existing cleanup.
The old ENROLLMENT_PEPPER secret is unused; it need not be rotated or distributed.

Default admission capacity is **100 registered active PCs**, each with **2 active
phone bindings**. These are identity/binding limits, not an entitlement to 100
simultaneous high-throughput users. Revoking a PC or binding releases that slot.
Existing identities still reconnect when registration closes or reaches capacity.
Apply additive migration `0004_capacity_indexes.sql` before this deployment.

### Free-tier capacity and overload behavior

The relay retains one hibernating SQLite Durable Object per PC, routed by PC ID;
no global relay object or paid Load Balancer is added. Each shard allows one live
socket per device, at most 3 total. Session renewal is spread over 60–75 minutes,
while business operations continue checking live revocation in D1. Identical event
replays avoid event/outbox rewrites. Cleanup alarms follow actual deadlines and
stop when no records or connections remain, instead of waking every ten minutes.

- Edge guards: 600 requests/minute per IP and 120/minute per bearer hash, per
  Cloudflare location. These cheap guards precede DB authentication; they are not
  global usage accounting. Shared networks can still experience temporary limits.
- Authoritative DB and shard budgets remain in place; rejected exhausted requests
  do not keep incrementing persistent counters. 429/503 replies include Retry-After.
- Push drains at most 4 jobs/alarm, 2 concurrently, with bounded retries and jitter.
  Terminal outbox history is capped at 1,000 rows; live authorization remains checked.
- Sampled logs/traces and content-free capacity/dependency/push-failure codes support
  diagnosis. `/healthz` reports configured capacity and liveness only, not DB health.

As checked on 2026-09-18, [Workers Free](https://developers.cloudflare.com/workers/platform/limits/)
allows 100,000 incoming requests/day. [D1](https://developers.cloudflare.com/d1/platform/pricing/)
and [SQLite DO storage](https://developers.cloudflare.com/durable-objects/platform/pricing/)
each have 5 million rows read and 100,000 rows written/day. DO compute also has
100,000 request units and 13,000 GB-s/day. Index writes, deletes and alarm writes
count; these limits are account-wide and are not multiplied by 100 shards.

The capacity setting is intended for notification-first, light phone usage. As a
planning example, 100 PCs online 8 hours/day need roughly 800 session renewals at
the minimum new TTL instead of 3,200. Two hundred phones foregrounded 5 minutes/day
perform about 2,000 periodic refresh cycles; each cycle can involve multiple HTTP
requests, pages and clock queries, with extra event-driven refreshes. This is a
planning envelope, not a measured 100-device production guarantee. Monitor actual
rows/CPU/duration and leave headroom; event size, retry rate and other Workers in
the account matter. At 200 phones foregrounded all day, just one request every
30 seconds is 576,000 requests/day, already exceeding Free before other calls.

Before sustained growth, check Cloudflare's Workers/D1/DO usage and error rates.
Investigate at 50% of a daily allowance; close new registration at 70% if projected
use threatens the remaining allowance, using the existing operator CLI. Preserve
existing bindings while diagnosing. Free-tier exhaustion or a regional/provider
outage can still interrupt the cloud leg; LAN and native desktop handling remain
independent. No plan upgrade, paid failover or quota-exhaustion SLA is implied.
For sustained foreground/high-event workloads, reduce client polling or explicitly
approve a paid plan after measurement. Application-level limits cannot prevent
an attacker from consuming the Workers incoming-request allowance itself.

For a synthetic public-relay emulator run, run `scripts/mobile-smoke-host.cjs`
from the repository root with `VIBE_HALO_TEST=1` and
`VIBE_HALO_SMOKE_RELAY_ORIGIN` set to the exact deployed HTTPS origin. No private
enrollment file is needed. This harness uses an isolated synthetic PC with ephemeral test encryption and binds its
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

## Notification language and meaning

Phone/watch notifications follow the Android app language (including system mode).
Install the updated APK and open it while online once to sync this preference;
offline changes are retained for retry. Legacy clients with no language preference
receive Chinese. Push text distinguishes approval, an in-app answer, a choice/input
requiring the original computer client, plan ready, and task completed. It includes
no command or question contents. Watches mirror the phone's single-language text.

## Connect and use

Desktop names initially follow the system hostname. Android reads the system's
device name, falling back to manufacturer/model. Rename this device in desktop
Mobile companion or Android Devices; **Use system name** restores automatic naming.
Names allow 1–48 Unicode characters and no control characters. Changes persist
offline and sync when connected. Signed display profiles are separate from
immutable device identities/grants: renaming never requires another pairing.

On first Android launch, a full-screen wizard presents one step at a time:
computer pairing, notifications, recent-app locking, then background battery settings.
Pairing is required; the remaining steps can be deferred. Navigation stays at the
bottom, and only the current step's content scrolls when needed.
Existing paired users skip this gate on upgrade. **Devices → Notifications and
background** reopens the wizard. Xiaomi/HyperOS guidance includes No restrictions
and background autostart. The battery button opens this app's system details.
Recent apps are opened with the system gesture or navigation button; no accessibility
or overlay permission is requested. In-app instructions use a black panel; system
pages use standard system-styled toasts. Notification and standard battery checks
refresh on return. Vendor locking/power/autostart settings remain unverified when
the OS cannot report them; there is no manual completion checkbox. Continuing a step
does not mark settings as enabled. These settings do not guarantee background delivery.

1. The desktop connects automatically. Open **Mobile companion / 手机伴侣** from
   the tray and wait for **Connected**. No enrollment code or relay entry is needed.
   Network errors retry in the background. Disabling the companion is remembered.
2. Generate a pairing code. Choose read-only permissions, or permissions for
   decisions and exact answers. Persistent authorization is a separate opt-in.
3. On Android choose **Connect a computer**, enter the pairing code (the default service is already selected), and compare all three fingerprint groups on both devices.
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

The Pending page aggregates bound PCs while keeping their queues separate. History
separates recent synced events (24 hours) from original computer history (up to
30 days/200 records per PC). Opening History loads authorized online PCs; Refresh
retries manually. Cards show client, computer, project/session context, content
summary, outcome and time. Details show bounded operation/question/answer/plan
sections rather than raw JSON. Legacy malformed or truncated responses fall back
to a readable summary. Active approvals and persistent permission scopes still
retain their required review context. Closing an input reminder does not answer the client.
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
