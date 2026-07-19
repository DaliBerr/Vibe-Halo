# Vibe Halo Project Handoff

Updated: 2026-07-19
Current version: `0.5.0`
Source directory: `C:\Tools\Clawd-island`

## Current Scope

Vibe Halo is a Windows, macOS, and Linux Electron dynamic-island interface for AI coding clients. Version 0.5.0 adds a platform runtime layer, stable POSIX Hook launcher, macOS accessory lifecycle, Linux X11/XWayland selection, and three-platform preview packaging while retaining the centered mini-island, one window, one global approval FIFO, loopback-only transport, strict renderer isolation, and fail-open behavior.

- Dynamic-island approvals: Codex, ZCode, Qwen Code, Copilot CLI, Claude Code, CodeBuddy, Hermes, and OpenCode.
- Exact interactive answers: ZCode `AskUserQuestion`, Claude/CodeBuddy Elicitation, and Hermes clarify.
- Native approval reminders: Kimi Code, Qoder, and QoderWork.
- Completion/status notifications: Gemini CLI, Antigravity, Cursor Agent, Kiro, CodeWhale, Pi, OpenClaw, Reasonix, and the approval clients.
- Codex `request_user_input` remains a read-only reminder because Codex does not expose a stable command-hook answer protocol.

The application does not contain desktop pets, remote approvals, a theme system, or the old Clawd on Desk multi-agent state machine.

## Architecture

- `src/agent-registry.js`: 19 client descriptors, bounded normalization, option allowlists, forms, and exact decision codecs.
- `src/integration-manager.js`: executable/config detection, incremental JSON/JSONC/TOML/plugin installation, first-state backups, health, repair, per-client overrides, and safe removal.
- `hooks/vibe-halo-hook.js`: self-contained command hook selected with `--agent` and `--event`; stdout is restricted to sanitized client protocol responses.
- `hooks/integrations/`: managed OpenCode reverse bridge, Hermes plugin, Pi extension, and OpenClaw plugin.
- `src/server.js`: authenticated `127.0.0.1` gateway with a 256 KiB request limit and adapter routing.
- `src/approval-store.js`: semantic decisions, `agentId`-isolated deduplication, connection fan-out, and the shared FIFO.
- `src/main.js`: service wiring, auto-scan, diagnostics, tray integration manager, and notification lifecycle.
- `src/platform-adapter.js`: platform/config paths, stable Hook runtime, process detection, login startup, notifications, package kind, and window-backend diagnostics.
- `src/update-manager.js`: signed-build gating, background update checks/downloads, bounded status, and explicit restart installation.
- `src/i18n.js`: complete `en-US`/`zh-CN` catalogs, system locale resolution, bounded interpolation, and renderer string projection.
- `src/shutdown-coordinator.js`: idempotent ordered shutdown that returns pending decisions to native client flows before update installation.
- `src/island-controller.js` and `src/renderer/`: current-item IPC validation, dynamic actions, overflow menu, interactive forms, sizing, focus, and animation.

## Safety Invariants

- Only an explicit current option ID can create a client decision. Close, disconnect, timeout, disabled approval, invalid data, and encoding failure use that adapter's native/no-decision output.
- The local service listens only on `127.0.0.1`, uses a fresh process token, and never sends raw client payloads or bridge secrets to the renderer.
- Integration changes are incremental, backed up separately per client, and remove only Vibe Halo-owned entries. Explicit client-level hook disabling is preserved.
- OpenCode uses a random loopback reverse bridge with a 32-byte bearer token, bounded pending IDs, replay protection, and a local-only target.
- Renderer navigation/new windows are blocked; Node is disabled and context isolation stays enabled.

## Verification Status

- Automated suite: 122 tests on Windows before cross-platform CI (121 passed, one POSIX-only process test skipped), covering 19 adapters, platform contracts, codecs, forms, global FIFO, server authentication/bounds, Windows/POSIX Hook paths, offline fallback, X11 source-window matching, installers, backups, idempotence, explicit disables, safe uninstall, IPC, sizing, stores, localization, settings migration, and legacy regressions. The POSIX process-runner test executes on macOS/Linux CI.
- Automatic-update suite: signed-build gating, scheduler state, download/install transitions, sanitized errors, ordered fail-open shutdown, external signing staging/injection, and signed-byte metadata regeneration.
- Windows: Codex/ZCode retain existing real-client validation. The 0.5.0 unpacked app launched in an isolated profile; an expanded approval action traversed Renderer IPC and cleared the queue. `Vibe-Halo-Setup-0.5.0-x64.exe` is unsigned, update-disabled, 102,778,900 bytes, and has SHA-256 `4271AFC8D4042D51ED21C444CCBF94D85DB213393891683D0D7D48FE60F1A304`.
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

- Electron 41, CommonJS, native HTML/CSS/JavaScript, and a single transparent window.
- Preview artifacts: Windows x64 NSIS; macOS 12+ arm64/x64 DMG and ZIP; Linux x64 AppImage and deb for Ubuntu 22.04/24.04 and Debian 12.
- Linux prefers X11/XWayland; `VIBE_HALO_NATIVE_WAYLAND=1` forces a diagnosed degraded native-Wayland mode.
- macOS runs as an accessory application without Dock presence or Accessibility/Screen Recording permissions.
- The stable POSIX launcher lives at `~/.vibe-halo/bin/vibe-halo-hook-runner`; remove all integrations before deleting the app on macOS/Linux.
- `preview-0.5.0` is a GitHub Pre-release built by `.github/workflows/cross-platform.yml`; it includes all platform packages and `SHA256SUMS.txt` but no stable update metadata. macOS packages are ad-hoc signed only, without Developer ID signing or notarization, and macOS/Linux auto-update stays disabled.
- Windows local artifacts remain unsigned and update-disabled. The separate stable `v*` workflow still signs the app EXE and NSIS elevation helper, then the generated uninstaller and final installer in order, and regenerates `latest.yml` and the blockmap.
- Version 0.2.3 requires one final manual bootstrap install of a signed release. The SignPath Foundation application has been submitted and is awaiting approval, so no public auto-update release may be created until approval and publisher verification are complete.
- Keep `LICENSE`, `NOTICE.md`, and upstream attribution in every release.
- `dist/`, `node_modules/`, `.smoke/`, logs, and contributor-local `AGENTS.local.md` are not committed.
- After moving source or installing a different build, run integration repair and review changed Codex Hook commands in `/hooks`.
