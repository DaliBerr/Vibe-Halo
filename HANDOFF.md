# Vibe Halo Project Handoff

Updated: 2026-07-20
Current version: `0.5.6`
Source directory: `C:\Tools\Clawd-island`

## Current Scope

Vibe Halo is a Windows, macOS, and Linux Electron dynamic-island interface for AI coding clients. Version 0.5.6 adds a separate tray-opened right-side recent-event window while keeping the live top-center island independent. Approval, question, best-effort Codex native-answer, and Codex plan records are retained for 30 days/200 items under a 16 MiB cap; ordinary completion notifications are excluded. History uses Electron secure storage when available and an explicitly warned plaintext fallback otherwise. The Windows x64 stable updater remains independent from Authenticode signing: official release builds opt into GitHub Releases updates with SHA-512 metadata, while SignPath is an optional, default-disabled enhancement.

- Dynamic-island approvals: Codex, ZCode, Qwen Code, Copilot CLI, Claude Code, CodeBuddy, Hermes, and OpenCode.
- Exact interactive answers: ZCode `AskUserQuestion`, Claude/CodeBuddy Elicitation, and Hermes clarify.
- Native approval reminders: Kimi Code, Qoder, and QoderWork.
- Completion/status notifications: Gemini CLI, Antigravity, Cursor Agent, Kiro, CodeWhale, Pi, OpenClaw, Reasonix, and the approval clients.
- Codex plan-mode turns receive a distinct plan-ready title and compact summary; completed plan output is shown when the Hook supplies it, with a localized fallback otherwise.
- Codex `request_user_input` remains a read-only reminder because Codex does not expose a stable command-hook answer protocol.

The application does not contain desktop pets, remote approvals, a theme system, or the old Clawd on Desk multi-agent state machine.

## Architecture

- `src/agent-registry.js`: 19 client descriptors, bounded normalization, option allowlists, forms, and exact decision codecs.
- `src/integration-manager.js`: executable/config detection, incremental JSON/JSONC/TOML/plugin installation, first-state backups, health, repair, per-client overrides, and safe removal.
- `hooks/vibe-halo-hook.js`: self-contained command hook selected with `--agent` and `--event`; stdout is restricted to sanitized client protocol responses.
- `hooks/integrations/`: managed OpenCode reverse bridge, Hermes plugin, Pi extension, and OpenClaw plugin.
- `src/server.js`: authenticated `127.0.0.1` gateway with a 256 KiB request limit and adapter routing.
- `src/approval-store.js`: semantic decisions, `agentId`-isolated deduplication, connection fan-out, and the shared FIFO.
- `src/completion-event.js`: bounded `Stop` normalization and Codex plan-mode classification using the documented Hook permission mode.
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

- Automated suite: 167 tests on Windows (166 passed, one POSIX-only process test skipped), including history retention/capacity, encrypted/plaintext persistence, corrupt-file fallback, structured redaction, semantic event capture, Codex native-answer parsing, duplicate suppression, isolated IPC, localization, right-side placement, fade lifecycle, renderer structure, package contents, and every existing 19-adapter/platform/update regression. The POSIX process-runner test executes on macOS/Linux CI.
- Automatic-update suite: independent release/update and signing gates, unsigned/signed public update configs, scheduler state, download/install transitions, sanitized errors, ordered fail-open shutdown, retained external signing staging/injection, and final-byte metadata regeneration.
- Windows: Codex/ZCode retain existing real-client validation. Normal packages remain update-disabled; the update-enabled unsigned `Vibe-Halo-Setup-0.5.5-x64.exe` passed package verification plus silent install/uninstall. The local artifact is 102,840,149 bytes with SHA-256 `20388D5D2B655B35554B71FD7F1C3F0C98C829FD7F53C58096AF1B56CF9DFED2`; 0.5.5 also corrects the CI-only PowerShell parser failure found by the unpublished `v0.5.4` run.
- Windows 0.5.6 local acceptance: the update-disabled unsigned `Vibe-Halo-Setup-0.5.6-x64.exe` is 102,856,176 bytes with SHA-256 `B0E6417D4C60792184D21B0AA7F568B5E8B9A5E36DC30129E235E360AE237CAE`. Package-content verification passed, and isolated Electron smoke runs captured the live island, history list, and approval detail simultaneously. A second launch reloaded encrypted history, increased the retained count, and exposed no example command plaintext in the envelope.
- macOS/Linux: first release is limited to CI contract, package, stable-runner, and isolated startup smoke tests. No real-client round-trip claim may be made until tested on physical installations.
- Codex: trusted Hook health detected; command Hook single-allow path returned the exact Codex protocol.
- ZCode 3.3.0: native process hooks use `cmd.exe` plus explicit arguments and a waiting, no-new-window PowerShell launcher. This is required because a direct PowerShell invocation detaches the packaged GUI-subsystem Electron process and returns empty stdout to ZCode before the Hook decision is ready. Health checks repair that legacy launcher, invalid wildcard matchers, and malformed 0.2.0 shell-command entries. Real approval, completion, structured `AskUserQuestion`, exact `updatedInput.answers` round-trips, immediate single-choice submission, and the final allow response are verified against the running app.
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
- `preview-0.5.3` is a GitHub Pre-release built by `.github/workflows/cross-platform.yml`; it includes all platform packages and `SHA256SUMS.txt` but no stable update metadata. macOS packages are ad-hoc signed only, without Developer ID signing or notarization, and macOS/Linux auto-update stays disabled.
- Windows local and preview artifacts remain update-disabled. The stable `v*` workflow defaults to an unsigned, update-enabled NSIS release and regenerates `latest.yml` and the blockmap from final bytes. Setting repository variable `VIBE_HALO_SIGNPATH_ENABLED=1` restores the retained three-stage SignPath path.
- Version 0.5.5 is the manually installed updater bootstrap. Version 0.5.6 is the first intended live N-to-N+1 acceptance target; record the final installed update result here after the stable release is published.
- Keep `LICENSE`, `NOTICE.md`, and upstream attribution in every release.
- `dist/`, `node_modules/`, `.smoke/`, logs, and contributor-local `AGENTS.local.md` are not committed.
- After moving source or installing a different build, run integration repair and review changed Codex Hook commands in `/hooks`.
