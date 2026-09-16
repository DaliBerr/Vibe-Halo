# Remote protocol v1

This is the implemented contract for the optional Android companion. See
[setup](REMOTE_SETUP.md), [decisions](REMOTE_DECISIONS.md) and dated acceptance
in [HANDOFF.md](../HANDOFF.md). PC-local authorization is authoritative; the relay
only carries authenticated, recipient-bound messages.

## Components and identities

`src/remote/remote-service.js` owns the PC identity, local grants, encrypted event
journal and transports. `device-credential-store.js` requires Electron safeStorage
and refuses Linux basic_text or corrupt storage. `lan-service.js` owns an independent
HTTPS/WSS listener. It never exposes the original loopback Hook API.

`services/relay` contains the Worker, D1 migrations and SQLite-backed `Relay`
Durable Object. Each PC has a separate DO and security domain (`space_<pcId>`).
`apps/android` stores a distinct phone identity and its grants for each relay
origin in Keystore-encrypted, no-backup storage. A phone can bind multiple PCs;
a PC can bind multiple phones. Device names never establish identity.

Each device has independent P-256 signing and ECDH keys. The PC has a third TLS
key. Key IDs are `sig:<RFC7638-thumbprint>` and `enc:<thumbprint>`. Public keys are
strict public P-256 JWKs. Cloud TLS validates normally; LAN uses the SHA-256 SPKI
pin in the explicitly confirmed grant. No network key URL, plaintext fallback,
key alias, name-only trust, or automatic key replacement is accepted.

## Enrollment, sessions and pairing

A root PC needs an administrator-created one-time enrollment code. D1 stores its
HMAC, expiry, consumed device ID and registration transaction ID. Proof covers the
exact PC public device, relay origin, code SHA-256 and fresh issuedAt. Repeating
the same registration is idempotent; another device cannot reuse the code.

Device authentication uses a 60-second, one-consumption challenge containing
nonce, device ID, signing key ID, origin and `device-session` purpose. The ES256
proof signs the original challenge. Sessions last 15 minutes; 256-bit opaque
bearers live only in client memory and only their SHA-256 hashes live in D1.
At most five active challenges and sessions are allowed per device. Re-authentication
uses a fresh challenge after a lost session response. Foreground clients renew;
Android has no permanent background authentication heartbeat.

Pairing uses a random 60-bit one-time code with a five-minute TTL. The PC signs an
offer binding its identity, origin, TLS pin, requested scopes and pairing ID. The
phone signs its identity and code digest. The relay atomically claims the code;
a claim is not an active binding. Both sides compute the same canonical transcript
and compare a 60-bit hexadecimal fingerprint. The PC persists its explicitly
confirmed grant before cloud activation; retries send the identical signed grant.
The phone verifies the complete original transcript and requires a final human
confirmation. Expiry/cancellation does not activate trust. Scopes are immutable
for a grant; change them by revoking and pairing again.

Grants contain PC/mobile public devices, origin, TLS pin, space/binding ID, revision,
pairing ID, issuedAt and scopes. Only the PC can create/expand local authority.
Cloud synchronization may reduce authority or confirm an already persisted grant,
never introduce a new local grant. Revocation is persisted before further decisions.
A cloud-disconnected PC may retain its last local LAN trust until it learns remote
revocation; the UI and setup documentation explicitly state this boundary.

## Wire formats and limits

`packages/protocol/schemas` defines EventSummary, EventDetail and DecisionIntent.
The committed standalone Ajv validators contain no runtime eval/compilation.
`npm run test:protocol` checks freshness and synthetic fixtures. Kotlin `Wire`
validates the same shipped schemas and UTF-8/tree/date constraints. Unknown protocol
versions, fields and decision aliases are rejected. Schema string limits count
Unicode code points; desktop semantic answers additionally enforce 2,000 UTF-16
code units, preserving existing adapter behavior.

| Resource | Bound |
| --- | --- |
| Control JSON / encrypted plaintext detail | 16 KiB / 64 KiB |
| Transport envelope / HTTP page | 256 KiB |
| Object traversal | depth 12, 4,096 nodes, bounded arrays |
| Form | 10 questions, 20 choices/question |
| Persistent scope preview | 16,000 characters; full, unredacted JSON |
| PC and relay event journal | 24 hours, 500 events, 10 MiB |
| PC decision receipts / relay receipts | 500, 10 minutes |
| Relay read queries | 64, 60 seconds |
| LAN challenges / sessions | 64 each, 30 seconds / 5 minutes |
| Relay WSS | 24 per PC DO, at most 2 per device |
| Original PC history reads | 25 summaries/page, 200 total, detail text 48 KiB |

UTF-8 byte budgets apply before parsing or during bounded stream reads. Details
reserve space for the encrypted wrapper. Oversized, truncated, redacted or incomplete
approval context becomes read-only; data is never truncated into a valid decision.
Sensitive fields are recursively sanitized. Commands, paths, question text and
answers are not in relay summaries, push payloads, logs or plaintext caches.

Messages use ES256 JWS first, then ECDH-ES/A256GCM compact JWE. JWS protected headers
are only `alg`, `kid`, `typ=vh1:<purpose>`. JWE headers are only `alg`, `enc`, `kid`,
`typ=vh1:encrypted`, `cty=JWS`, and a public P-256 `epk`. No compression or remote
key lookup is allowed. Libraries verify the original signed bytes; canonical JSON
is only for semantic transcript comparison, not reconstruction before verification.

Purposes separate `enrollment`, `device-session`, `pairing-offer`, `pairing-claim`,
`pairing-status`, `binding-grant`, `lan-session`, `message` (event detail),
`decision-intent`, `decision-receipt`, `read-request`, `read-response` and
`notification-ack`. Encrypted bodies bind protocol version, origin, PC/mobile IDs,
binding ID/revision and message-specific event/request IDs. Authentication to one
PC, binding, role or purpose never grants another operation.

## Events and decisions

An event summary contains IDs, PC process epoch, stream sequence, event revision,
kind, adapter ID, creation/expiry times, state, queue actionability, pending count
and a localization key. Details are individually signed/encrypted for each phone.
The decrypted summary must exactly match its transport summary. Queue actionability
is independent of a phone's scopes; `remoteActionable` additionally reflects
complete context, local control and binding permissions.

Every PC restart changes its epoch. Pending journal records restored after restart
become expired/read-only. Queue changes increment affected revisions without
extending the original 120-second deadline. `events` pages include a snapshot
version (sequence and count). Android stages all bounded pages and restarts a
changed snapshot at most twice; it never treats an inconsistent partial page as
current actionable state. Missing records stay cached read-only. Foreground resume
performs full reconciliation; terminal states and newer revisions cannot be
replaced by old pending data. Repeated cached signed PC time cannot extend a
phone's countdown. Backgrounding invalidates the local actionable clock until sync.

A DecisionIntent carries decision ID, PC/mobile/binding identity, binding revision,
PC epoch, event/approval ID, expected event revision, full context digest, exact
option ID, optional answers and a bounded issuedAt/expiresAt. Persistent actions
also require `persistentConfirmed=true` and a complete preview in the current PC
context. `DecisionService` synchronously rechecks current local grants/scopes,
control switch, queue head, epoch, revision, digest, absolute deadline, options,
answers, persistent opt-in and shutdown state immediately before finalizing.

LAN and cloud submit the same encrypted intent and decision ID. The first valid
PC decision wins. Same-ID/same-content retries return its receipt; changed content
is a conflict. Cached receipts do not bypass current trust checks. No approval is
saved offline for automatic later execution. A native/client decision, disconnect,
expiry or PC click cannot accidentally affect the next queued request.

The relay responds `relay_received`, `desktop_offline`, `waiting` or
`desktop_result`. Only the verified PC receipt can say `desktop_accepted`.
That status does not claim the client executed a command. Other results include
`expired`, `forbidden`, `stale_epoch`, `stale_revision`, `stale_context`,
`not_current`, `invalid_answers`, conflicts and `result_unknown`. Receipt loss is
queried/retried with the original ID. Invalid/closed forms leave the waiter intact.
Only existing adapter codecs write client stdout. Codex request_user_input and
passive approval notifications never gain fabricated reply/approve protocols.

## Reads, reminders and transports

History requests use `read-request`/`read-response` purposes and fresh request IDs.
Only `clock.read`, `history.list`, `history.detail` and `reminder.dismiss` are accepted. The PC
checks the appropriate current scope after decryption. History is read-only;
reminder dismissal also requires the local control switch and the matching input
event epoch/revision, and only dismisses Vibe Halo's reminder, never answers the
client or finalizes a Hook approval. History/reminder result envelopes retain the bound
`history.response` type and request ID, including an empty records list for dismiss.

`clock.read` requires `events.read` and returns a signed/encrypted `clock.response`
with the fresh request ID, current `pcTime` (Unix milliseconds) and PC session
epoch. It exposes no history or decision operation. Its nonce-bound response does
not depend on the phone wall clock being synchronized. Android accepts a sample
only within a five-second monotonic round trip, advances conservatively by that
round trip, never rolls time backwards within an epoch and requires recalibration
after 60 seconds or backgrounding. Cached event `pcTime` is not a fresh clock
sample. Countdown and decision timestamps use this clock; failed calibration or
a different epoch makes the event read-only. The PC still enforces the absolute
deadline at its final decision gate.

Cloud endpoints cover enrollments, challenge/session, pairing create/claim/status/
confirm/cancel, devices, binding revoke/PC acknowledgment, push-token/preferences,
and per-PC stream/events/decisions/queries. Routes are allowlisted in `index.ts`.
D1 authentication and active bindings are rechecked on every operation and WSS
business message. DO sockets use `ctx.acceptWebSocket` plus validated attachments;
there is no always-running polling loop. SQL journals, receipts, read requests and
push jobs survive hibernation; alarms prune and retry bounded batches.

LAN exposes only challenge/session, events, decisions, queries, notification-ack
and stream on a separate HTTPS listener. mDNS TXT contains protocol version and
PC ID only. Private/link-local addresses remain untrusted until pinned TLS and
signed challenge verification succeed. Cloud bearers are never sent to LAN.
Foreground Android prefers LAN and subscribes to pinned WSS hints; failed LAN
uses the normal HTTPS cloud client. Network/endpoint changes renew LAN sessions.
Backgrounding stops discovery/sockets. A 30-second foreground reconciliation also
covers missed hints. No router forwarding, shell, Hook configuration, updates or
remote desktop endpoint exists.

## Notifications and privacy

The Worker sends FCM HTTP v1 `notification + data`. Body/title are short generic
bilingual reminders. Data is restricted to version, PC/epoch/event IDs, revision
and kind, with no authorization, token, command or answer. Requests use HIGH
priority, completions NORMAL; TTL never exceeds event expiry and is capped at
10 minutes. Stable channels are approvals, questions, completions and
connection_status. Tagging by PC/event collapses duplicates. Notifications only
open an explicit immutable app intent with bounded PC/epoch/event IDs; there are
no decision actions, RemoteInput, full-screen intents or watch receivers.

A foreground notification coordinator checks local preferences, system permission
and channel importance, records bounded revisions, and clears terminal events.
A signed LAN acknowledgment means `notification_posted` or `suppressed_by_user`;
only the owning phone's verified current acknowledgment suppresses its cloud job.
It is not proof of user/watch delivery. Background FCM auto-display remains managed
by the Android SDK; local foreground contextual-action settings cannot override
all system-generated behavior. Late background reminders may still appear, but
opening them cannot restore old authority.

Push tokens are encrypted in D1 with independent AES-256-GCM and device-ID AAD.
Token rotation/preferences/revocations retry on foreground sync; token rotation
also schedules bounded network-constrained WorkManager maintenance (five attempts,
no approval polling). FCM 429/5xx obey bounded backoff and Retry-After; invalid
UNREGISTERED responses deactivate only the matching current token revision.
Before sending, jobs recheck binding, event revision, expiry and acknowledged state.
No analytics, account login, remote private-key backup or notification-listener
permission is introduced. No forward-secrecy claim is made against later device
ECDH private-key compromise, and timing/adapter metadata remains visible to relay.
