# Mobile companion decisions

Accepted implementation brief: `Vibe-Halo-Mobile-Implementation-Plan-v1.0.md`,
2026-09-16. The user requested implementation on 2026-09-16. This records product
decisions, not a declaration that remote access is available. Dated progress and
verification belong in [HANDOFF.md](../HANDOFF.md).

| Decision | Implementation boundary |
| --- | --- |
| Q1: Android and available Google services | Kotlin/Compose Android companion and FCM HTTP v1 only; no iOS/APNs or watch app. Record actual phone/watch versions during acceptance. |
| Q2: One-time code, no GitHub account | Device signing/encryption keys, one-time pairing, locally computed matching fingerprints and explicit PC confirmation; short device sessions, no user accounts or refresh tokens. |
| Q3: Personal use with headroom | N:M bindings, one security domain and approval FIFO per PC, configurable capacity and controlled PC enrollment; self-hostable. |
| Q4: Cloud fallback accepted | Authenticated foreground LAN preferred; Cloudflare and FCM for background, failed LAN and cross-network use. |
| Q5: View/interact | Existing protocol-backed approvals/forms, input reminders, plans/completions and read-only history. No mobile Hook installation, configuration changes, updates, restart or arbitrary execution. |
| Q6: Notification is only a reminder | No approve/reject/reply actions, RemoteInput or watch decision receiver. Opening a notification only opens a verified current detail. |
| Q7: Keep encryption manageable | Standard ES256 JWS, then ECDH-ES/A256GCM JWE per recipient; separate signing/encryption/TLS keys. Library and Android Keystore interoperability must pass before sensitive traffic. No custom cryptography or plaintext downgrade. |
| Q8: Keep deadline | 120 seconds from enqueue; Hook HTTP 130 seconds and configuration 150 seconds unchanged. Queue promotion, opening a detail and reconnect do not restart the deadline. |

PC is the final authority. Timeout/disconnection/native fallback never means
automatic approval. Only the current FIFO request and an exact adapter option can
produce a decision; Codex `request_user_input` stays read-only.

Remote access and remote control default off. Per-binding scopes separate
`events.read`, `history.read`, `approvals.decide`, `questions.answer`, and
`reminders.dismiss`. `approvals.persistent` requires explicit local opt-in and a
complete permission preview with a second confirmation on the phone. Until that
preview and permission flow exist, the remote decision service rejects persistent
options even if the local adapter supports them.

Cloudflare Worker/SQLite Durable Objects/D1 and Android FCM are the planned
services. Public deployment, application-store publication and paid upgrades are
not authorized by the implementation brief. Credentials stay in local secure
storage or service secrets, never in Git, chat, ordinary settings or fixtures.

Protocol v1 budgets: 16 KiB control, 64 KiB detail, 256 KiB encrypted envelope,
10 questions, 20 options per question, 2,000 UTF-16 code units per answer (matching
the existing desktop and Kotlin string bounds). Reject duplicate multi-select
answers, unknown fields, dangerous object keys, invalid option IDs and oversized
messages instead of truncating them into a valid decision.

Desktop stays CommonJS/Electron with native HTML/CSS/JS. Android `minSdk=26` is a
candidate only; Kotlin/Compose/Gradle/Firebase/JOSE/HTTP dependencies and final
SDK targets remain to be frozen after compatibility checks. Installed SDKs alone
do not establish Android build, Keystore, background-push or watch support.
