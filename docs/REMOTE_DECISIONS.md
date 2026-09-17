# Mobile companion decisions

Accepted implementation brief: `Vibe-Halo-Mobile-Implementation-Plan-v1.0.md`,
2026-09-16. The user requested implementation on 2026-09-16. This records the implemented product contract; deployment and device acceptance
are separate from source availability. Dated progress and
verification belong in [HANDOFF.md](../HANDOFF.md).

| Decision | Implementation boundary |
| --- | --- |
| Q1: Android and available Google services | Kotlin/Compose Android companion and FCM HTTP v1 only; no iOS/APNs or watch app. Record actual phone/watch versions during acceptance. |
| Q2: One-time code, no GitHub account | Device signing/encryption keys, one-time pairing, locally computed matching fingerprints and explicit PC confirmation; short device sessions, no user accounts or refresh tokens. |
| Q3: Personal use with headroom | N:M bindings, one security domain and approval FIFO per PC, configurable capacity and automatic signed PC registration; self-hostable. |
| Q4: Cloud fallback accepted | Authenticated foreground LAN preferred; Cloudflare and FCM for background, failed LAN and cross-network use. |
| Q5: View/interact | Existing protocol-backed approvals/forms, input reminders, plans/completions and read-only history. No mobile Hook installation, configuration changes, updates, restart or arbitrary execution. |
| Q6: Notification is only a reminder | No approve/reject/reply actions, RemoteInput or watch decision receiver. Opening a notification only opens a verified current detail. |
| Q7: Keep encryption manageable | Standard ES256 JWS, then ECDH-ES/A256GCM JWE per recipient; separate signing/encryption/TLS keys. Library and Android Keystore interoperability must pass before sensitive traffic. No custom cryptography or plaintext downgrade. |
| Q8: Keep deadline | 120 seconds from enqueue; Hook HTTP 130 seconds and configuration 150 seconds unchanged. Queue promotion, opening a detail and reconnect do not restart the deadline. |

PC is the final authority. Timeout/disconnection/native fallback never means
automatic approval. Only the current FIFO request and an exact adapter option can
produce a decision; Codex `request_user_input` stays read-only.

Updated by the user on 2026-09-17: the desktop automatically connects to the default relay without an enrollment code. Service administration stays in the separate authenticated operator CLI. Explicitly disabling the companion persists across restarts. Remote control remains off by default. Per-binding scopes separate
`events.read`, `history.read`, `approvals.decide`, `questions.answer`, and
`reminders.dismiss`. `approvals.persistent` requires explicit local opt-in and a
complete permission preview with a second confirmation on the phone. The PC supplies the full original OpenCode pattern set or Claude permission
suggestion. Missing, truncated or redacted scopes cannot be authorized remotely.
Changing a binding’s granted scopes requires revocation and a new pairing.

Cloudflare Worker/SQLite Durable Objects/D1 and Android FCM are implemented.
Self-hosted setup is documented in [REMOTE_SETUP.md](REMOTE_SETUP.md).
The local preview defaults to the deployed test relay. No production service guarantee, paid upgrade, store publication or desktop release is implied. Credentials stay in local secure
storage or service secrets, never in Git, chat, ordinary settings or fixtures.

Protocol v1 budgets: 16 KiB control, 64 KiB detail, 256 KiB encrypted envelope,
10 questions, 20 options per question, 2,000 UTF-16 code units per answer (matching
the existing desktop and Kotlin string bounds). Reject duplicate multi-select
answers, unknown fields, dangerous object keys, invalid option IDs and oversized
messages instead of truncating them into a valid decision.

Desktop stays CommonJS/Electron with native HTML/CSS/JS. Android uses minSdk 26,
compile/target SDK 36, AGP 8.13.2, Gradle 8.13, Kotlin 2.4.20 and JDK 21 for builds
(Java 17 bytecode). `apps/android/gradle/libs.versions.toml` freezes runtime versions.
Compose BOM 2025.10.01, Activity 1.11.0 and Lifecycle 2.9.4 were selected to support
the installed Studio 2025.2.1/SDK 36 toolchain. R8 9.1.43 overrides AGP’s bundled
shrinker to handle Kotlin 2.4 metadata, following the [official compatibility table](https://developer.android.com/build/kotlin-support)
and [R8 override instructions](https://r8.googlesource.com/r8/+/refs/heads/main/README.md).
The optional Nimbus XC20P provider is not bundled; strict wire checks only permit
A256GCM. Node `jose` 6.2.12 and Android Nimbus 10.9.1 use standard JOSE primitives.

Android signing keys are non-exportable P-256 Android Keystore keys. For API 26
compatibility, the independent ECDH private key is encrypted by a Keystore AES-GCM
key in no-backup storage. This fallback is not described as hardware ECDH. Keys
are separate per relay origin. Linux `basic_text` safeStorage is refused.

Pairing fingerprints encode 60 SHA-256 bits in three groups of five hexadecimal
characters. This keeps the plan’s 60-bit comparison strength without introducing
a second Base32 encoder. Pairing codes use 60 random bits and a five-minute TTL;
PC registration uses a fresh signed device proof, bounded registration rate and transactional capacity enforcement; it needs no administrator code.

Protocol JSON Schema string bounds count Unicode code points; semantic answer
bounds additionally preserve the existing desktop limit of 2,000 UTF-16 code units.
UTF-8 byte budgets are independent. Phone recent events use the same 24-hour /
500-event / 10-MiB bound as the remote journal; original PC history is fetched
only on demand, read-only, with at most 200 summaries and 4 MiB of detail in memory.

A fresh desktop installation connects automatically and starts an independent pinned
LAN listener; the control switch stays off. VIBE_HALO_RELAY_ORIGIN selects a
self-hosted relay on first setup; the original Hook
listener remains loopback-only. No firewall exception or router port forwarding
is installed automatically. Offline LAN trusts the last PC-local grant; cloud
revocation cannot reach a disconnected PC. Once learned, revocation is persisted
before further local authorization. A lost identity requires revoking old grants
and a new enrollment/pairing, never silent key replacement.
