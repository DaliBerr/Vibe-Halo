# Vibe Halo Project Handoff

Updated: 2026-09-18 (synced-event history parsing and pairing-first Android wizard)
Current version: `0.5.9`
Source directory: `C:\Tools\Clawd-island`

## 2026-09-18 — Synced-event history parsing and pairing-first wizard

Fixed the real-phone report of protocol JSON in recent-event history. Android's
optString had stringified the nested summary object, and plain completion/plan
toolInputText was skipped. History now uses a typed HistoryView for both synced
events and computer records, accepts only actual text fields, parses known tool
arguments/question arrays, and shows title/type, source, content and result cards.
Legacy and cached records are normalized on read without clearing data. Unknown
structures and missing answers have explicit fallback labels; a resolved request
does not imply approval or an answer. Active approval review remains unchanged.

Replaced the scrolling setup checklist with a persisted one-step-at-a-time wizard:
pairing, notifications, recent-app locking, battery settings. Pairing is embedded
with fixed action controls, required before first entry, and verified pairing /
notifications advance automatically. Other steps can be deferred. Existing paired
upgrades still enter the app directly; reopening setup does not revoke that access.
Notification checks include permission, global enablement and primary channels;
resume refreshes standard battery optimization/background restriction signals.
OEM lock/autostart/power policy remains unverified, never inferred from visiting
settings or the old manual-confirm flags. Removed manual completion controls.

User explicitly selected no additional permissions: recents uses the user's
gesture/navigation key; black instructions are in-app, and system pages get a
standard Toast with OS-controlled styling. Battery setup opens application details,
not Xiaomi's hidden powerkeeper activity. No accessibility/overlay permission,
relay API, migration, desktop binary or production configuration change is needed.

Verification: root 227 tests (226 passed, existing Windows POSIX skip), Android
debug/release builds and lint, 13 instrumentation tests including the real nested
event envelope, legacy data, question arrays, missing/malformed content, lifecycle
refresh, upgrade gate and small-screen navigation. Screenshots and logs are in
.smoke/history-wizard-* and .smoke/wizard-*. Signed release installed over the
existing emulator application using the original certificate (SHA-256 starts
4771d9bec52ebed7). No phone/device data reset or remote CI/CD was performed.
Physical Xiaomi 15 settings/toast behavior and locked-phone/watch notification
delivery remain user acceptance. Continue on codex/mobile-foundation; the wider
companion acceptance gates still block merging this branch to main or publishing.

## 2026-09-17 — Device names, first-run setup and readable Android history

Implemented the user-approved plan on codex/mobile-foundation. Device display
names follow system names by default (installed PC: RETARD), support local rename
and reset, and sync signed monotonic profiles without modifying identity keys,
pairing transcripts or existing grants. Android migrates the old Android default
to the system name; existing custom names persist. Queued profile changes survive
offline operation and restart. Desktop/phone peer lists verify the pinned sender
key before using profile metadata. Pairing screens can show the latest profile.

Android first launch now shows four separate setup steps: notifications, locking
in recent apps, battery/background settings and pairing. The first three can be
deferred; one completed pairing is needed to enter the application. Existing
active bindings bypass this first-run gate on upgrade; Devices reopens setup.
Xiaomi/HyperOS settings have intent fallbacks and explicitly manual confirmation
for states the OS cannot report. No background-residency guarantee is made.

Replaced slogans with functional labels, reused desktop Halo artwork for launcher
and in-app branding, added adaptive/monochrome notification icons, and collapsed
device connection details. History separates 24-hour synced events from computer
history. Cards show content, client, PC, project/session context, result and time;
details show questions/answers or bounded excerpts instead of JSON. Optional
history viewVersion 2 preserves old client response shapes; Android converts valid
legacy responses and falls back to summaries for malformed/truncated text. Active
decision and persistent-scope review requirements remain unchanged.

Deployed additive D1 migration 0003 and Worker version
4a586e89-fd8b-4c55-b266-27f8d1f21747 at the existing relay. No credentials, bindings,
limits or notification routing fields changed. Local verification: root 227 tests
(226 pass, existing Windows POSIX skip), relay typecheck plus 11 tests, Firebase
debug/release builds and lint, Android setup/history/layout/notification tests,
and public CompanionFlowTest including bidirectional rename, immutable pairing,
readable encrypted history, cloud/LAN decisions and revocation. UI screenshots
cover Chinese/English, large text and the signed release's light/dark setup.
Desktop packaged approval smoke and real settings-window rename/reset passed;
the installed desktop and signed APK deliverables were updated without CI/CD.

Two environment findings were resolved during acceptance. Emulator DNS timed out
despite IP connectivity; restarting Small_Phone with explicit 1.1.1.1/8.8.8.8 DNS
restored the successful public flow. The release emulator also contained a binary,
invalid-UTF-8 companion cache last modified 2026-09-16 18:20 UTC, before this task.
Its encrypted bytes were preserved in .smoke/release-cache-inspect and the exact
emulator file was renamed with a corrupt-20260916-preserved suffix. No physical
phone data was touched. Added a non-destructive load-error/retry screen so invalid
saved data cannot leave the new initial-loading gate spinning indefinitely.

Evidence logs/screenshots use .smoke/device-ui-*, .smoke/setup-*,
.smoke/history-zh.png and .smoke/release-setup-*.png. Synthetic cloud PCs were
revoked, the bridge was stopped, and test forwards were removed. Actual installed
PC pc_16d9239a-dd96-4093-bb58-3af861b11c04 and its active phone binding remain;
the user's enabled control preference is preserved. Physical Xiaomi 15 device-name,
HyperOS settings and locked-phone/watch delivery remain user acceptance. No tag,
store release, remote CI/CD or main merge: the wider companion acceptance gates
below still apply.

## 2026-09-17 — Input-reminder display and single-language notifications

User report: the Codex three-choice test in task 01a0af32-3e83-7260-8fc1-135ed47b9a3d
reached phone/watch but was not seen on the PC island. Installed logs show the
request was detected and input-request-compact was queued at 11:48:37 UTC, then
resolved at 11:50:26. Those historical logs record requested UI state, not proof
of physical visibility or the display used at that moment.

Found and fixed a reproducible mixed-DPI placement error: native Windows window
rectangles are physical pixels, while Electron display rectangles are DIP. A local
real-window test on the 100% + 150% display arrangement selected the wrong monitor
with the old calculation, and the source monitor after screenToDipRect conversion.
Compact input text and expanded three-choice read-only rows both rendered, with
zero renderer errors. Codex answers still belong in the original Codex interface.

Cloud FCM previously concatenated Chinese and English and grouped input/approvals
under one generic message. Now the authenticated phone preference includes an
optional validated zh-CN/en-US locale; language changes queue a persisted preference
and sync online, including when following the system language. The previous enabled
preference is preserved, and revisions stay monotonic. Legacy clients without a
synced locale receive Chinese until upgraded. Foreground and background copy now
distinguishes approval, in-app answer, original-client input/choice, plan and completion.
Notifications still contain only short classification text and the same six routing
fields, with no command/question contents, decision actions or inline replies.

Verification: root 224 tests (223 pass, existing Windows POSIX skip); relay type
check and 10 tests; Firebase debug/release builds and lint; dedicated release APK
signature verification; Android NotificationSafetyTest 2 tests; opt-in real-FCM
setup and language-sync tests. Actual background SDK notifications (ID 0) received
English "Choice or answer needed" after en-US sync, then Chinese "任务已完成" after
zh-CN sync. Physical watch mirroring is still for the user to verify after updating.

Worker version 139d683d-f449-4afc-90d7-fd18e2080d6a deployed at the existing origin.
No schema migration or credential rotation. Windows package and local approval
smoke passed; the installed desktop matches the fixed build. Signed APK and Windows
installer refreshed in dist/companion-preview. Synthetic public root/bridge are
cleaned up after the check; actual user bindings are preserved. No remote CI/CD or
release tag; the wider companion acceptance gates below still apply.

## 2026-09-17 — Automatic companion connection; separate service administration

The user explicitly replaced controlled PC enrollment with default automatic
connection, removed administrator codes from the application, and requested local
verification without remote CI/CD. This supersedes the default-off/enrollment-code
product choices in the historical entry below; remote control still defaults off.

- Desktop startup asynchronously registers a signed device identity against the
  default relay, without blocking local Hooks on a network request. Failed initial
  registration retries with backoff and the same persisted identity. An explicit
  disable survives restart, and a late registration response cannot re-enable it.
- Desktop onboarding has no relay-address or enrollment-code inputs. Android selects
  the same default service; only the phone pairing code and matching fingerprints
  are needed. Self-hosted Android origin is under an optional setting; desktop
  first setup accepts VIBE_HALO_RELAY_ORIGIN. Existing origins/grants are preserved.
- Service operations stay in services/relay/scripts/admin.mjs, outside app packages:
  status, open-registration, close-registration, revoke-pc. No public admin endpoint
  or operator credentials were added. Public registration retains rate limiting,
  a transactional active-PC cap, identity-conflict checks and revoked-device denial.
- Migration 0002_self_service_registration.sql applied to the existing isolated D1.
  Worker version 55b66a15-35ec-4508-aecc-149d60baabff deployed at the existing public
  origin. FCM configuration and resource limits remain unchanged. This is a direct
  deployment needed for local public-service tests, not a CI/CD workflow run.
- Local root suite: 223 tests, 222 passed and the existing Windows POSIX skip.
  Relay type check and 10 runtime tests pass, including two distinct PCs racing
  for the last capacity slot, idempotent retry at capacity, closure and revocation.
- Updated Firebase Android debug and minified release builds/lint pass; release APK
  signed using the existing dedicated key and installed in the API 34 emulator.
  CompanionFlowTest passes against the public relay after code-free PC enrollment:
  fingerprint pairing, encrypted cloud decision, pinned LAN fallback, exact forms,
  timeout clock and revocation. Requests/waiters are synthetic, not real coding UI.
- Packaged Windows whitelist and local approval smoke pass. Real Electron/safeStorage
  UI test connects automatically, shows no admission/address inputs, has no renderer
  errors or horizontal overflow, keeps control off, and persists disable/re-enable.
  The installed desktop was updated in place; its local encrypted state confirms
  enrolled=true, enabled=true, controlEnabled=false with the expected relay.
- Signed Android onboarding visually verified: pairing-code field only by default,
  optional self-hosted settings collapsed. A transient emulator System UI ANR was
  dismissed using the earlier Android Studio task guidance; app UI recovered.
- Both synthetic public PC roots were revoked, and bridge/ADB forwards were stopped.
  The actual installed desktop identity is preserved. Updated deliverables remain
  in dist/companion-preview, including refreshed usage instructions and hashes.

No remote CI/CD, store upload or release tag was requested or run. Physical phone,
watch/cellular and real-client acceptance from the earlier task remain open; the
larger companion branch is not merged as a production-accepted feature.

## 2026-09-16 — Android companion implementation and local acceptance

Baseline: `ee3338dee7e0e15711cae55eb6a49ced84a6567d` on main; implementation branch
`codex/mobile-foundation`. The accepted v1.0 implementation plan was based on an
older upstream revision; existing local changes were preserved. Separate M1 fixes
are `a844c84` and `dcf2776`. Desktop version remains 0.5.9; no release/tag is implied.

Implemented: independent PC settings/identity/grants/journal/LAN service, shared
strict decision gate and protocol crypto, Worker/D1/hibernating SQLite DO relay,
controlled enrollment, pairing, scoped revocation, bounded FCM outbox, Android
Compose UI and Keystore identity, pinned LAN/cloud routing, encrypted approvals,
forms, receipts, reminders, original read-only history, English/Chinese UI and
notification-only Android integration. Scope changes require re-pairing. Node
Hooks keep their original loopback listener and 120/130/150-second relationship.

Operational and security documentation is consolidated in
[REMOTE_SETUP.md](docs/REMOTE_SETUP.md), [REMOTE_PROTOCOL.md](docs/REMOTE_PROTOCOL.md)
and [REMOTE_DECISIONS.md](docs/REMOTE_DECISIONS.md), rather than duplicate status
files. New independent CI builds/lints Android and checks the relay/shared protocol.

Verified locally on Windows with Node 24.14.0, Electron 41.10.2, Studio 2025.2.1,
JBR 21.0.8 and the API 34 Small_Phone emulator:

- Root `npm test`: 219 tests, 218 passed, one existing POSIX-only Windows skip.
- `npm run test:protocol`: 6 passed, generated validators current.
- Relay TypeScript check and Vitest: 8 passed in local workerd/D1/DO. Dry-run
  deploy bundle succeeds. Test workerd compatibility is capped at 2026-08-22 by
  its bundled runtime; deployment compatibility remains 2026-09-16.
- Android debug/instrumentation and minified unsigned release builds plus both
  lint variants pass. R8 9.1.43 handles Kotlin 2.4 metadata; older AGP's synchronous
  resource-provider warnings and two compatible deprecated FCM token API warnings
  do not fail the build. Gradle distribution checksum is pinned.
- Emulator instrumentation verifies Node-to-Kotlin-to-Node JWS/JWE Unicode round
  trip, key reuse, tamper rejection and identical canonical pairing transcripts.
- Full emulator flow verifies PC/phone fingerprint confirmation, cloud allow,
  wrong LAN certificate rejection, LAN deny after disconnecting PC cloud WSS,
  LAN WSS event hint, closed-answer rejection, valid single/multi-select/Unicode
  form delivery through the actual registry codec, receipts and binding revocation.
  The requests and waiter are synthetic; this is not a real coding-client UI run.
- NotificationManager instrumentation checks no actions/RemoteInput/full-screen
  intent, immutable detail navigation, tag/revision deduplication, terminal cleanup
  and forged action metadata rejection. Tests wait for asynchronous system publish
  and cancellation instead of assuming notify() is an immediate display receipt.
- Compose instrumentation checks all 12 action buttons remain scroll-accessible
  at a short 320×420 layout with 200% text, and unbound context remains disabled.
- Windows package whitelist verifies all new runtime modules; isolated packaged
  startup, synthetic local approval and bounded quit pass. Packaged companion
  imports, real Windows safeStorage encryption, sandbox preload and settings
  rendering pass with no renderer error or horizontal overflow. Android English
  home and PC Chinese settings were visually inspected.
- Maintainer enrollment-code script ran against local D1 without printing its
  code. A candidate-source scan matched none of the actual local test peppers or
  token encryption key; ignored runtime/config/signing files remain excluded.

M0/M1 local foundations are verified. M2–M5 have local protocol/emulator and real
public foreground/background transport evidence. Sustained M3 CPU/hibernation,
real-client M4 and physical M5/M6 acceptance remain open. M7 builds/docs/local
regressions are prepared; **the whole feature is not declared production accepted**.
The user restored Cloudflare login and supplied Firebase project `vibe-halo`
Android configuration and a matching service-account JSON in Downloads. A debug
Android app `com.vibe.halo.mobile.debug` was additionally registered in that same
project through Firebase's Management API, preserving the user's release app
`com.vibe.halo.mobile`. No paid plan, store upload or desktop release tag was made.

Public relay: `https://vibe-halo-relay.z1593316231.workers.dev`, deployed version
`ccac0b0e-bb24-41cd-941a-0ae8c459f111`. New isolated D1 database
`912b3b29-35b1-46f8-93df-64b013315e22` has migration `0001_identity.sql`; existing
account projects were not changed. Production config is the ignored sibling
`services/relay/wrangler.production.jsonc`, while the committed template remains
unconfigured. Three independent relay secrets and three FCM service fields were
provisioned as Worker secrets; FCM is enabled. Relay secret recovery is Windows
user-DPAPI encrypted at
`C:\Users\15933\.vibe-halo\companion-deployment\relay-secrets.dpapi.json`
(an earlier ignored `.smoke` copy is retained). Service credentials remain in
the user's original Downloads JSON and Worker secrets, never Git or APKs.

The API 34 emulator passed `CompanionFlowTest` against this real HTTPS Worker:
controlled PC enrollment, fingerprint pairing, cloud approval and encrypted
receipt, followed by forwarded pinned LAN decisions/forms after PC cloud
disconnect, and revocation. `/healthz` returned 200. The public test PC was then
root-revoked with the admin script; remote D1 reports zero active PCs and zero
active bindings. The synthetic host and its current ADB forwarding were removed.
This is real public foreground transport, but still a synthetic client waiter,
not a cellular phone, real multicast discovery or long-run free-tier metrics.

Real FCM background delivery was then observed on API 34 after instrumentation
exited and the app returned to Home. D1 contains an encrypted active push token;
the system showed a Firebase auto-displayed notification (`id=0`, event tag,
`approvals` channel, PRIVATE visibility). Its visible generic bilingual body has
no approval/reply action; tapping opened the correct encrypted event detail.
Evidence includes ignored `.smoke/fcm-background.png` and the target-app system
notification record. This is actual Google delivery, not the mock provider test.

The dedicated signed/R8 release APK was also installed as `com.vibe.halo.mobile`
and paired through its actual UI, comparing the displayed fingerprint before PC
confirmation. Release FCM delivery was observed while the display was Dozing,
and again with `cmd deviceidle force-idle deep` reporting IDLE. An approximately
one-minute-old notification opened with about 64 seconds remaining instead of
restarting at 120; tapping Deny produced exactly one PC `deny` result. A later
20-minute-old notification opened read-only with disabled decision buttons and
the original PC timeout/native fallback. After explicit package force-stop,
no notification appeared for a new event during a 50-second observation window;
no phone decision was submitted. The app was reopened and forced idle removed.
The earlier `am kill` was combined with Doze, so independent OS reclamation is
still not claimed. Final cleanup again reports zero active PC domains and
bindings; the synthetic server and known test forwards are stopped. Target
phone/watch/cellular behavior and sustained production budget measurements remain
open.

That delayed-open test found stale cached event time restarting the apparent
120-second countdown. Fixed with nonce-bound encrypted/signed `clock.read`,
PC epoch validation, a five-second sample RTT bound and a 60-second monotonic
clock lease. Time cannot move backwards within an epoch; foreground refresh now
uses current PC time even for an old cached event. Four Android unit tests and
the updated public emulator flow (deliberate delayed first fetch) pass. A fifth
desktop protocol test checks read scope, skew-tolerant clock challenge and wrong
request-ID rejection. Actual decision deadlines still belong to the PC. Terminal
notification reconciliation also cancels Firebase's auto-display ID, verified
alongside the app's foreground notification ID in instrumentation.

Local test deliverables are collected in ignored `dist/companion-preview/`: the
Firebase-configured debug APK, minified release APK, Windows x64 NSIS companion
preview and SHA-256 checksums. The installable `Vibe-Halo-Mobile-0.1.0.apk` uses
the release Firebase app and a dedicated RSA-3072 signing key, with verified APK
v2/v3 signatures. Key and DPAPI-encrypted password are retained outside temporary
files at `C:\Users\15933\.vibe-halo\android-signing\`; preserve them for updates.
Certificate SHA-256 is
`4771d9bec52ebed7895873037cb67e97d369c52572f7bb45e4441117106d3106`.
No debug signing key is used for the release. CI initializes the current Android
SDK explicitly and avoids the removed legacy `tools` package.

Cross-platform packaging at `40097ce` passed Windows, macOS ARM64/x64 and Linux,
including each platform's packaged startup smoke. The first Ubuntu XWayland UI
smoke exited without enough diagnostics; rerun `35108422568` passed all compact,
expanded, plan/history screenshots and the approval-click flow. PNGs and log
artifacts are now retained, and the expanded island/history detail PNGs were
visually inspected. The initial failure remains unexplained rather than being
represented as a proven production rendering fix. A later Intel macOS run
`35108605727` demonstrated that fixed-delay smoke exit can destroy the history
IPC before a slow renderer loads. Smoke jobs now await all capture/action work,
retry empty/unloaded frames and fail after a bounded timeout. Four regression
tests cover delayed completion, task failure, timeout and empty-frame retries.
Production approval deadlines and ordinary quit behavior are unchanged.

Cross-platform CI `35109995360` and mobile CI `35109995336` at `9a1280c` both pass.
Clock/FCM changes at `020e8f8` also pass cross-platform CI `35112663455` and mobile
CI `35112663377`. The final Android UI follow-up `3f586b3` explicitly labels
expired/ended records and does not imply that every terminal record lost context.
Final source `3f586b3` passes cross-platform CI
`https://github.com/DaliBerr/Vibe-Halo/actions/runs/35115775577` and mobile CI
`https://github.com/DaliBerr/Vibe-Halo/actions/runs/35115775735`. The final signed
APK includes the matching release Firebase app ID, clock challenge and explicit
terminal-state strings (verified in packaged DEX). SHA-256 of the installable
release APK is `96fe6dc4a3ec09a4b6d81e24972c19395d90508503159987ddb61c5608707acd`;
the full binary checksum list and Chinese physical-test guide are in ignored
`dist/companion-preview/`. Subsequent handoff-only commits do not change binaries.
The branch remains pushed but unmerged while the plan's real-client/physical
acceptance and production budget gates remain open; no tag or app-store release
was created.
Android CI passes relay/protocol checks plus debug, instrumentation
APK and R8 release builds and both lint variants on Ubuntu. The cloud CI builds
the instrumentation APK; actual instrumentation execution is the local emulator
evidence above.

### T01–T68 classification (2026-09-16)

“Pass” below is limited to the stated local evidence. “Unverified” explicitly
retains physical, production-service or real-client portions; a mock provider
response is never counted as FCM/watch delivery. No item is silently omitted.

| ID | Status | Evidence / remaining boundary |
| --- | --- | --- |
| T01 | Pass | Root regressions and isolated packaged Windows local approval/quit. |
| T02 | Pass | 19-adapter registry/codec fixtures; existing verification levels preserved. |
| T03 | Pass | Non-head intent rejected without changing either waiter. |
| T04 | Pass | Encrypted LAN/cloud gateway duplicate executes once; shared receipt cache. |
| T05 | Unverified | First-winner store/gateway races pass; simultaneous taps on two physical phones not run. |
| T06 | Pass | Local-first/remote-first fixture cannot resolve the next request. |
| T07 | Unverified | Native-first disconnect regression passes; no new live ZCode UI session was exercised. |
| T08 | Pass | Absolute expiry checked before delayed timer callback. |
| T09 | Pass | Stale epoch rejected; restored journal pending records expire. |
| T10 | Pass | Strict closed forms/unknown options/duplicate multi-values; emulator valid and invalid form round trip. |
| T11 | Pass | OpenCode once/reject codecs and full-scope persistent gate; Claude suggestion codec fixtures. |
| T12 | Pass | Registry and remote fixtures keep Codex input/passive integrations read-only. |
| T13 | Pass | No close/background decision call; foreground sockets close and local actionable clocks invalidate. |
| T14 | Unverified | Shutdown tests and packaged normal quit pass; real updater installation during network loss not rerun. |
| T15 | Pass | Observer/write error and lost receipt tests retain honest unknown/accepted semantics and idempotency. |
| T16 | Pass | Atomic concurrent claim, consumed code rejection, expired grant and bounded rate checks. |
| T17 | Pass | Pre-PC-confirmation phone cannot authenticate to business APIs; emulator checks waiting confirmation. |
| T18 | Pass | Pinned key/signature/transcript checks and tamper tests; names are not authority. |
| T19 | Pass | Cross-PC domain API denial and per-binding encrypted history authorization. |
| T20 | Pass | Unbound PC access rejected by relay and final PC decision gate. |
| T21 | Pass | Role/route allowlists and default-denied persistent grant tests; no remote management endpoint. |
| T22 | Pass | Wrong keys/purposes/headers/ciphertext plus stale digest/PC/epoch/revision fixtures. |
| T23 | Pass | Same decision ID with changed plaintext/ciphertext conflicts; stale signed intents rejected. |
| T24 | Pass | Revoked WSS session rechecked; revoked binding cannot reuse old token/cache. |
| T25 | Unverified | Local revocation closes emulator LAN access; delayed cloud revocation of a physically offline PC still needs field testing. |
| T26 | Pass | Concurrent nonce consumes once; fresh challenge/session and same persisted PC grant retry paths. |
| T27 | Pass | Refuses unavailable/basic_text storage; damaged credentials are not overwritten. Windows DPAPI exercised. |
| T28 | Pass | Candidate-source secret scan, package whitelist and APK asset/manifest review; only synthetic test traffic. |
| T29 | Pass | Shared schema/tree/UTF-8 limits and oversized Worker enrollment body rejection. |
| T30 | Pass | Role-checked PC WSS publishing and phone signature trust; unsupported stream operations reject. |
| T31 | Unverified | Emulator forwarded pinned HTTPS/WSS succeeds; actual Wi-Fi multicast discovery not a forwarded-loopback test. |
| T32 | Unverified | Real public FCM auto-display verified on a background API 34 emulator; target phone/lock-screen Wi-Fi acceptance remains separate. |
| T33 | Unverified | Public relay foreground path passes; still requires configured FCM and cellular phone. |
| T34 | Unverified | Cloud fallback and wrong TLS rejection exercised; AP isolation/mDNS blocking/OS LAN denial need real network tests. |
| T35 | Unverified | Endpoint-bound sessions and monotonic cache implemented; physical IP/IPv6/network-switch matrix pending. |
| T36 | Pass | Actual TLS client rejects a wrong PC SPKI; LAN uses separate signed session, never cloud bearer. |
| T37 | Pass | Emulator LAN read/decision/form works after the PC cloud stream is deliberately disconnected; no offline wake claim. |
| T38 | Unverified | SQLite persistence/hibernation APIs compile and local DO tests pass; public cold reconstruction/hibernation measurement pending. |
| T39 | Unverified | Bounded retries/capacity failures tested locally; actual free-plan quota exhaustion not induced. |
| T40 | Pass | Mock HTTP v1 429/503/UNREGISTERED, encrypted token revision handling and bounded maintenance paths; delivery unverified. |
| T41 | Unverified | Local dedup/ACK and both foreground/FCM notification-ID cleanup verified; delayed duplicate FCM versus LAN race matrix remains pending. |
| T42 | Pass | Terminal revision suppresses old foreground reminder; stale detail cannot regain authority. Background SDK display remains best effort. |
| T43 | Unverified | Signed emulator APK receives during forced deep idle; explicit force-stop suppresses new display for 50 seconds with no decision. Independent OS reclamation and physical-device matrix remain pending. |
| T44 | Unverified | Signed release opens a 20-minute-old notification read-only; delayed cached-event countdown fixed with fresh PC clock challenge. Physical cold-start/new-intent lifecycle matrix pending. |
| T45 | Unverified | Permission/channel checks implemented; actual DND, denied permission and unreachable provider matrix pending. |
| T46 | Unverified | No-GMS physical environment unavailable; UI distinguishes unconfigured Firebase from foreground capability. |
| T47 | Unverified | No physical target watch/companion forwarding settings available. |
| T48 | Unverified | Short generic Chinese/English templates and Unicode crypto pass; actual watch truncation/emoji pending. |
| T49 | Pass | NotificationManager inspection plus manifest/intent code checks: no decision/reply action or unprotected decision receiver. |
| T50 | Unverified | Matching release/debug Firebase apps verified and real debug delivery works; deliberate project/package mismatch matrix not exercised. |
| T51 | Pass | Main projects Stop/input events before local busy/UI gates; original desktop priority tests pass. |
| T52 | Pass | Queue watermark/revision fixtures and bounded staged snapshot reconciliation; emulator reconnect succeeds. |
| T53 | Pass | Bounded encrypted journal/cache and receipt capacity/expiry fixtures; old pending records do not revive. |
| T54 | Pass | 2 PCs × 3 phones in D1/DO fixtures with selected-binding revocation and separate PC authority. |
| T55 | Pass | Desktop, shared protocol, Worker Vitest and Android instrumentation run independently. |
| T56 | Pass | Windows/macOS ARM64/x64/Linux packaging and isolated startup passed CI; local Windows NSIS and Android debug/release builds pass. Physical desktop/client acceptance is separate. |
| T57 | Unverified | Real device signature/FCM service-auth and first push succeed; sustained CPU/DO billing and quota budget measurement remain pending. |
| T58 | Unverified | Local and public D1 migrations/deployments pass; rollback with live records not performed. |
| T59 | Pass | Controlled enrollment idempotency/reused code/active-PC cap and malformed-body rejection. |
| T60 | Pass | Device/session role and signed challenge device/origin/purpose tampering rejected. |
| T61 | Unverified | 15-minute auth renewal and separate FCM identity implemented; real background expiry plus delivery pending. |
| T62 | Unverified | Same-install Keystore reopen tested and backups excluded; real reinstall/key-loss/other-device migration pending. |
| T63 | Pass | Relay 2-PC test removes one binding without invalidating the other; Android cache removal is per computer. |
| T64 | Pass | Actual Node ↔ Android Keystore/Nimbus JWS/JWE with Chinese/emoji/newline and tamper rejection. |
| T65 | Pass | Full transcript fingerprint, grant equality, key-purpose/header checks and changed-scope rejection. |
| T66 | Pass | 2-PC × 3-phone fixtures; configured active-PC cap and bounded request/rate limits reject excess work. |
| T67 | Pass | Debug/release build and manifest/asset review: no iOS/APNs, user OAuth, accessibility or notification listener; no service private key. |
| T68 | Pass | PC-local persistent opt-in, full unredacted preview, explicit phone confirmation and original action ID required. |

## Current Scope

Vibe Halo is a Windows, macOS, and Linux Electron dynamic-island interface for AI coding clients. Version 0.5.9 raises Codex `request_user_input` reminders in ordinary/default as well as Plan mode, using bounded in-memory Session origin data to correct the reminder to the source display without taking focus. It also codifies ZCode 3.10.1's concurrent native/Hook approval behavior: the first decision wins and the cancelled connection is removed idempotently. Exact current-turn Codex Auto-review requests remain with the native reviewer, with conservative island fallback whenever that version-sensitive context cannot be verified. Approval, question, best-effort Codex native-answer, and Codex/ZCode plan records are retained for 30 days/200 items under a 16 MiB cap; ordinary completion and bypassed Auto-review requests are excluded.

- Dynamic-island approvals: Codex, ZCode, Qwen Code, Copilot CLI, Claude Code, CodeBuddy, Hermes, and OpenCode.
- Exact interactive answers: ZCode `AskUserQuestion`, Claude/CodeBuddy Elicitation, and Hermes clarify.
- Native approval reminders: Kimi Code, Qoder, and QoderWork.
- Completion/status notifications: Gemini CLI, Antigravity, Cursor Agent, Kiro, CodeWhale, Pi, OpenClaw, Reasonix, and the approval clients.
- Codex and ZCode plan-mode turns receive a distinct, client-aware plan-ready title and compact summary; completed plan output is shown when the Hook supplies it, with a localized fallback otherwise.
- Codex Auto-review detection is exact-turn and fail-safe: only a matching `turn_context` with an interactive policy and `auto_review` reviewer bypasses the island; missing or unknown data keeps the existing approval flow.
- Codex `request_user_input` remains a read-only reminder because Codex does not expose a stable command-hook answer protocol; default, Plan, and unknown modes all remain eligible for the reminder.
- ZCode 3.10.1 on Windows presents native and Hook approval concurrently; the first explicit decision wins, while older versions can remain Hook-first.

The application now includes an optional, default-disabled Android companion with encrypted remote approvals. It does not contain desktop pets, a user-configurable theme system, or the old Clawd on Desk multi-agent state machine. Existing system light/dark appearance is supported.

## Architecture

- `src/agent-registry.js`: 19 client descriptors, bounded normalization, option allowlists, forms, and exact decision codecs.
- `src/integration-manager.js`: executable/config detection, incremental JSON/JSONC/TOML/plugin installation, first-state backups, health, repair, per-client overrides, and safe removal.
- `hooks/vibe-halo-hook.js`: self-contained command hook selected with `--agent` and `--event`; it performs bounded, read-only exact-turn Auto-review detection before runtime lookup, and stdout is restricted to sanitized client protocol responses.
- `hooks/integrations/`: managed OpenCode reverse bridge, Hermes plugin, Pi extension, and OpenClaw plugin.
- `src/server.js`: authenticated `127.0.0.1` gateway with a 256 KiB request limit and adapter routing.
- `src/approval-store.js`: semantic decisions, `agentId`-isolated deduplication, connection fan-out, and the shared FIFO.
- `src/session-origin-store.js`: bounded six-hour in-memory mapping from exact client/Session IDs to source process chains for display placement; it is never persisted or exposed to renderers.
- `src/completion-event.js`: bounded `Stop` normalization and Codex/ZCode plan-mode classification using the documented Hook permission mode.
- `src/main.js`: service wiring, auto-scan, diagnostics, tray integration manager, and notification lifecycle.
- `src/platform-adapter.js`: platform/config paths, stable Hook runtime, process detection, login startup, notifications, package kind, and window-backend diagnostics.
- `src/update-manager.js`: release-build gating, background update checks/downloads, bounded status, and explicit restart installation.
- `src/i18n.js`: complete `en-US`/`zh-CN` catalogs, system locale resolution, bounded interpolation, and renderer string projection.
- `src/shutdown-coordinator.js`: idempotent ordered shutdown that returns pending decisions to native client flows before update installation.
- `src/island-controller.js` and `src/renderer/`: current-item IPC validation, dynamic actions, overflow menu, interactive forms, sizing, focus, and animation.
- `src/history-store.js` and `src/history-events.js`: fixed-schema event capture, sensitive-field redaction, 128 KiB record bounds, retention/capacity pruning, atomic encrypted/plaintext persistence, and corruption fallback.
- `src/history-window-controller.js`, `src/history-preload.js`, and `src/history-renderer/`: isolated right-side history window, bounded list/detail IPC, fixed-region copy controls, filtering, localization, multi-display placement, and five-second pointer-leave fade.

## Safety Invariants

- Only an explicit current option ID can create a client decision. Close, disconnect, timeout, disabled approval, invalid data, and encoding failure use that adapter's native/no-decision output.
- The local service listens only on `127.0.0.1`, uses a fresh process token, and never sends raw client payloads or bridge secrets to the renderer.
- Integration changes are incremental, backed up separately per client, and remove only Vibe Halo-owned entries. Explicit client-level hook disabling is preserved.
- OpenCode uses a random loopback reverse bridge with a 32-byte bearer token, bounded pending IDs, replay protection, and a local-only target.
- Renderer navigation/new windows are blocked; Node is disabled and context isolation stays enabled.
- History never stores runtime/bridge tokens, authentication headers, cookies, PID chains, or original protocol payloads. The history renderer cannot choose paths or arbitrary clipboard text and cannot replay client actions.

## Verification Status

### Mobile implementation started — 2026-09-16

- Brief: user-provided mobile implementation plan v1.0; accepted product choices
  and conservative Q5 scope are in `docs/REMOTE_DECISIONS.md`.
- Baseline HEAD: `ee3338dee7e0e15711cae55eb6a49ced84a6567d`; clean worktree,
  fetched origin and fast-forward check found main current. Compared with the
  plan's `fd3e48f` baseline, only AGENTS/HANDOFF documentation differs. Work is
  isolated on `codex/mobile-foundation`.
- Environment: Windows, Node `24.14.0`, npm `11.9.0`, Java `25.0.3`; Android SDK
  platform `android-36`, build tools `35.0.0`/`36.1.0` found. Gradle, Kotlin CLI
  and adb were not on PATH. No Android device, Firebase, Cloudflare or Keystore
  round trip was verified. Do not treat these as completed M0 gates.
- Baseline `npm test`: 181 tests, 180 pass, 1 POSIX-only skip, 0 failures.
- First safety change: desktop decision/close handlers use DecisionService;
  user decisions check FIFO, exact option and the absolute deadline before
  resolving. Strict forms reject extra questions, closed-option violations,
  single-select multiple values, duplicates, oversize values and dangerous keys
  before finalize. Store timeout/disconnect/shutdown fallback stays separate.
- After safety change `npm test`: 188 tests, 187 pass, 1 POSIX-only skip,
  0 failures. New service and real IPC tests cover stale requests, timer delay,
  native-first cancellation and invalid answers without waiter completion.
- This is staged implementation, not a working mobile feature. No remote
  listener, cloud connection, device enrollment, Android APK or FCM notification
  has been enabled. M0 external verification and M2–M7 remain outstanding.

#### M1 foundation checkpoint

- Safety checkpoint commit: `a844c84`. The next checkpoint adds the protocol and
  simulated remote decision boundary; it remains on the development branch
  because the mobile feature and its security gates are incomplete. No push,
  main merge, version bump, release tag or external deployment was performed.
- Added three versioned JSON schemas, TypeScript declarations, a synthetic
  Chinese/emoji/newline fixture, and committed standalone validators generated
  with Ajv `8.20.0`. Ajv was already resolved at this version in the lockfile;
  the change makes it an explicit pinned development dependency without changing
  any resolved dependency versions. The installed packaging tools are Electron
  `41.10.2` and electron-builder `26.15.3`, not the lower package.json ranges.
- Added queue event IDs, process epoch, absolute expiry, business revision and
  sequence watermark. Detached internal pages and whitelisted, byte-bounded
  network summaries remain separate. The initial projector supports approvals
  and exact questions; input/Stop/plan projection and the unified journal await M3.
- Default-disabled internal remote gate checks verified-principal authorization
  callbacks, PC/binding/mobile/revision, FIFO/epoch/context/deadline, scopes,
  details and answers. Bounded receipts handle duplicate/conflicting IDs and
  uncertain post-finalize errors. This callback is simulated in tests; it does
  not implement device authentication, JWS/JWE, LAN or Cloudflare.
- Final local `npm test`: **204 tests, 203 passed, 1 POSIX-only skip, 0 failed**.
  `npm run test:protocol`: **6 passed**, including generated-source freshness.
  Earlier intermediate syntax-check failure during refactoring was fixed before
  these final runs. Logs: `.smoke/mobile-foundation-tests.log` (untracked).
- `npm run build:dir` and `npm run verify:package --
  dist/win-unpacked/resources 0.5.9` passed on Windows x64. The asar contains the
  service, projector and protocol runtime; relay/Android sources, schema/test
  tooling and known credential filenames are excluded. The local package keeps
  auto-update disabled. Build log: `.smoke/mobile-foundation-build.log`.
- Packaged isolated action smoke returned `resolved`, captured the history list
  and detail, and exited with code 0. The action intentionally resolves before
  the island capture timer; a separate non-action smoke captured the expanded
  island and exited with code 0. Visual inspection confirmed readable history
  detail and visible approval controls. Seven packaged runtime files also match
  current source bytes. Test directories are `.smoke/mobile-foundation` and
  `.smoke/mobile-foundation-ui`; real user settings and Hook configuration were
  not used. This is synthetic desktop validation, not a real mobile/client round trip.
- Dependency audit reports 7 existing high-severity package findings (Electron,
  xmldom, brace-expansion, fast-uri, js-yaml, tar and undici). No resolved versions
  changed in this checkpoint; a dependency/security update remains separate work.
  Audit output stays in `.smoke/mobile-audit.json`, not source control.

Plan matrix coverage at this checkpoint:

| IDs | Evidence and remaining boundary |
| --- | --- |
| T01–T02 | Original desktop regressions and 19-adapter contracts pass; Windows packaged synthetic actions/UI pass. Other platforms and new real-client runs not performed here. |
| T03–T10 | Local/simulated FIFO, duplicate, winner, disconnect, timeout, epoch and strict-answer tests pass. Physical LAN/cloud and multi-phone races still await transports. |
| T11–T15 | Existing codecs/reminder contracts and shutdown regression pass; incomplete/persistent remote actions are rejected and uncertain results tested. Persistent opt-in, mobile lifecycle and Hook-write receipt tracking remain unimplemented. |
| T19–T23, T29 | Internal authorization/context/replay and malformed-message simulations pass. Actual device authentication, signatures, encryption and cross-space HTTP/WSS authorization remain unverified. |
| T24–T28, T30–T50 | Not verified end to end; require M2 identity, remote infrastructure, Android and physical devices. Synthetic local revocation tests do not establish cloud revocation. |
| T51–T54 | Journal, complete business stream, snapshot/delta replay and multi-device caches still pending; current queue pages are bounded and expose a watermark. |
| T55–T56 | Isolated test discovery and Windows package contents verified; macOS/Linux builds not executed in this run. |
| T16–T18, T57–T68 | Pairing/enrollment, deployment/load, Android/Keystore/JOSE and watch acceptance remain pending. T68 only verifies default rejection; no persistent opt-in is enabled. |

Next implementation work: complete M0 Node↔Kotlin JOSE/Keystore feasibility and
version freezing; then M2 secure credentials, local binding confirmation,
challenge/session authentication and revocation. Build the authenticated cloud
vertical slice with synthetic data before transmitting real details, then M3
notification/journal and M4–M7. Missing physical/service acceptance must be
reported explicitly, not replaced with these simulated tests.

### Prior desktop verification

- Recorded live acceptance on 2026-08-30: the installed 0.5.8 discovered and downloaded 0.5.9, then explicitly restarted through the built-in updater. The application-ready log and installed executable confirmed 0.5.9; the installed Hook matched the repository SHA-256. The user confirmed an ordinary-mode Codex question appeared, and logs confirmed expansion and resolution after answering. ZCode native-first and island-first clicks after this upgrade remain pending manual acceptance; automated cancellation tests and installed 3.10.1 source/config inspection do not establish that final UI result.
- Automated suite: 181 tests on Windows (180 passed, one POSIX-only process test skipped), including ordinary/Plan/unknown Codex input reminders, Codex Hook/JSONL Session namespace matching, bounded Session origin isolation and expiry, source-display correction without focus, ZCode native-winner connection cancellation, exact-turn Codex Auto-review routing, history persistence/redaction, localization, package contents, and every existing 19-adapter/platform/update regression. The POSIX process-runner test executes on macOS/Linux CI.
- Automatic-update suite: independent release/update and signing gates, unsigned/signed public update configs, scheduler state, download/install transitions, sanitized errors, ordered fail-open shutdown, retained external signing staging/injection, and final-byte metadata regeneration.
- Windows: Codex/ZCode retain existing real-client validation. Normal packages remain update-disabled; the update-enabled unsigned `Vibe-Halo-Setup-0.5.5-x64.exe` passed package verification plus silent install/uninstall. The local artifact is 102,840,149 bytes with SHA-256 `20388D5D2B655B35554B71FD7F1C3F0C98C829FD7F53C58096AF1B56CF9DFED2`; 0.5.5 also corrects the CI-only PowerShell parser failure found by the unpublished `v0.5.4` run.
- Windows 0.5.6 local acceptance: the update-disabled unsigned `Vibe-Halo-Setup-0.5.6-x64.exe` is 102,856,176 bytes with SHA-256 `B0E6417D4C60792184D21B0AA7F568B5E8B9A5E36DC30129E235E360AE237CAE`. Package-content verification passed, and isolated Electron smoke runs captured the live island, history list, and approval detail simultaneously. A second launch reloaded encrypted history, increased the retained count, and exposed no example command plaintext in the envelope.
- Windows 0.5.8 local acceptance: the update-disabled unsigned `Vibe-Halo-Setup-0.5.8-x64.exe` is 102,856,735 bytes with SHA-256 `162182EFEF78C100E43D6B3FCF3D2E2208E2987855591AA9DED9843C7172FFDC`. `build:dir`, packaged-content verification, and NSIS construction passed with version 0.5.8, x64 metadata, bundled licenses/NOTICE, and updates disabled in the local package.
- Windows 0.5.9 local acceptance: the final update-disabled unsigned `Vibe-Halo-Setup-0.5.9-x64.exe` is 102,858,413 bytes with SHA-256 `F24F97A53E082B032995F7CC7ABCB31E05013BD483AE9FAE87703FE845225DE4`. Packaged-content verification confirmed the new Session origin module, version, licenses/NOTICE, and disabled local updater. Isolated packaged smokes resolved an approval through the renderer, captured the expanded island plus history list/detail, and exited cleanly.
- macOS/Linux: first release is limited to CI contract, package, stable-runner, and isolated startup smoke tests. No real-client round-trip claim may be made until tested on physical installations.
- Codex: an isolated Codex CLI 0.147.0-alpha.6.6 acceptance used a real `on-request + auto_review` turn and confirmed the production Hook was invoked, returned no decision before contacting Vibe Halo, and left the native guardian to approve the action. The running desktop app also returned exact Codex `allow` and `deny` protocol results for user-reviewed requests; stale/unknown turn-state isolation is covered by dedicated fixtures.
- ZCode 3.10.1: inspection of the installed Windows client confirms that its native permission broker and `PermissionRequest` Hook now race concurrently. Automated HTTP cancellation coverage verifies native-first cleanup, stale-decision rejection, and a clean subsequent FIFO request; island-first allow/deny keeps the existing exact codec. The managed Hook remains a structured `cmd.exe` process with explicit arguments and a waiting, no-new-window PowerShell launcher. Older ZCode releases can remain Hook-first; Vibe Halo does not use the private app-server RPC.
- Cursor 2.2.44: auto-detected; installed Hook `stop` and `beforeSubmitPrompt` protocols verified against the running app, including same-session notification cleanup.
- Claude configuration: backup and incremental merge verified; installed Elicitation hook and answer round-trip verified manually. No runtime claim is made when the Claude executable is absent.
- Qwen, Copilot, Gemini, OpenCode, OpenClaw, and other local configuration traces: valid JSON, first backup, incremental merge, health, and third-party preservation verified. Runtime status remains contract-only when no executable is available.
- Kiro is detected from its initialized home but intentionally remains uninstalled when its agent configuration directory is absent.

## Development and Release

```powershell
npm install
npm test
npm start
npm run build:dir
npm run build
```

- Electron 41, CommonJS, native HTML/CSS/JavaScript, one transparent live-island window, and one optional transparent history window.
- Preview artifacts: Windows x64 NSIS; macOS 12+ arm64/x64 DMG and ZIP; Linux x64 AppImage and deb for Ubuntu 22.04/24.04 and Debian 12.
- Linux prefers X11/XWayland; `VIBE_HALO_NATIVE_WAYLAND=1` forces a diagnosed degraded native-Wayland mode.
- macOS runs as an accessory application without Dock presence or Accessibility/Screen Recording permissions.
- The stable POSIX launcher lives at `~/.vibe-halo/bin/vibe-halo-hook-runner`; remove all integrations before deleting the app on macOS/Linux.
- `preview-0.5.9` and `v0.5.9` were published on 2026-08-30 from commit `fd3e48f`, after cross-platform CI passed. The preview includes all platform packages and `SHA256SUMS.txt` but no stable update metadata. The Windows stable release includes the installer, blockmap, `latest.yml`, checksums, LICENSE and NOTICE. Its installer SHA-256 is `B88E4B8B141474FE8BE8FDF0FAFCFA7D8783F6D816A0C7442EAA00F3E53CBD51`. macOS packages are ad-hoc signed only, without Developer ID signing or notarization, and macOS/Linux auto-update stays disabled.
- Windows local and preview artifacts remain update-disabled. The stable `v*` workflow defaults to an unsigned, update-enabled NSIS release and regenerates `latest.yml` and the blockmap from final bytes. Setting repository variable `VIBE_HALO_SIGNPATH_ENABLED=1` restores the retained three-stage SignPath path.
- Version 0.5.5 is the manually installed updater bootstrap. The live 0.5.5 → 0.5.6 update check, download, explicit restart installation, and encrypted-history persistence acceptance passed on Windows.
- Keep `LICENSE`, `NOTICE.md`, and upstream attribution in every release.
- `dist/`, `node_modules/`, `.smoke/`, logs, and contributor-local `AGENTS.local.md` are not committed.
- After moving source or installing a different build, run integration repair and review changed Codex Hook commands in `/hooks`.
