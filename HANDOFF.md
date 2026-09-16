# Vibe Halo Project Handoff

Updated: 2026-09-16 (guide audit; runtime evidence below remains dated)
Current version: `0.5.9`
Source directory: `C:\Tools\Clawd-island`

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

The application does not contain desktop pets, remote approvals, a user-configurable theme system, or the old Clawd on Desk multi-agent state machine. Existing system light/dark appearance is supported.

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
