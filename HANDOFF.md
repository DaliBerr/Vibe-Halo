# Vibe Halo Project Handoff

Updated: 2026-07-18
Current version: `0.2.1`
Source directory: `C:\Tools\Clawd-island`

## Current Scope

Vibe Halo is a Windows-first Electron dynamic-island interface for AI coding clients. Version 0.2.1 fixes ZCode process-hook execution and matcher compatibility while retaining one window, one global approval FIFO, loopback-only transport, strict renderer isolation, and fail-open behavior.

- Dynamic-island approvals: Codex, ZCode, Qwen Code, Copilot CLI, Claude Code, CodeBuddy, Hermes, and OpenCode.
- Exact interactive answers: ZCode `AskUserQuestion`, Claude/CodeBuddy Elicitation, and Hermes clarify.
- Native approval reminders: Kimi Code, Qoder, and QoderWork.
- Completion/status notifications: Gemini CLI, Antigravity, Cursor Agent, Kiro, CodeWhale, Pi, OpenClaw, Reasonix, and the approval clients.
- Codex `request_user_input` remains a read-only reminder because Codex does not expose a stable command-hook answer protocol.

The application does not contain desktop pets, remote approvals, a theme system, automatic updates, or the old Clawd on Desk multi-agent state machine.

## Architecture

- `src/agent-registry.js`: 19 client descriptors, bounded normalization, option allowlists, forms, and exact decision codecs.
- `src/integration-manager.js`: executable/config detection, incremental JSON/JSONC/TOML/plugin installation, first-state backups, health, repair, per-client overrides, and safe removal.
- `hooks/vibe-halo-hook.js`: self-contained command hook selected with `--agent` and `--event`; stdout is restricted to sanitized client protocol responses.
- `hooks/integrations/`: managed OpenCode reverse bridge, Hermes plugin, Pi extension, and OpenClaw plugin.
- `src/server.js`: authenticated `127.0.0.1` gateway with a 256 KiB request limit and adapter routing.
- `src/approval-store.js`: semantic decisions, `agentId`-isolated deduplication, connection fan-out, and the shared FIFO.
- `src/main.js`: service wiring, auto-scan, diagnostics, tray integration manager, and notification lifecycle.
- `src/island-controller.js` and `src/renderer/`: current-item IPC validation, dynamic actions, overflow menu, interactive forms, sizing, focus, and animation.

## Safety Invariants

- Only an explicit current option ID can create a client decision. Close, disconnect, timeout, disabled approval, invalid data, and encoding failure use that adapter's native/no-decision output.
- The local service listens only on `127.0.0.1`, uses a fresh process token, and never sends raw client payloads or bridge secrets to the renderer.
- Integration changes are incremental, backed up separately per client, and remove only Vibe Halo-owned entries. Explicit client-level hook disabling is preserved.
- OpenCode uses a random loopback reverse bridge with a 32-byte bearer token, bounded pending IDs, replay protection, and a local-only target.
- Renderer navigation/new windows are blocked; Node is disabled and context isolation stays enabled.

## Verification Status

- Automated suite: 19 adapters, codecs, forms, global FIFO, server authentication/bounds, command-hook E2E, offline fallback, installers, backups, idempotence, explicit disables, safe uninstall, IPC, sizing, stores, and legacy regressions.
- Windows unpacked build: 0.2.1 launches, creates a valid process-owned runtime identity, and loads all unpacked managed assets.
- Codex: trusted Hook health detected; command Hook single-allow path returned the exact Codex protocol.
- ZCode 3.3.0: native process hooks use an executable `command` plus explicit `args`; invalid wildcard matchers and malformed 0.2.0 shell-command entries are repaired. Real approval, completion, structured `AskUserQuestion`, and exact `updatedInput.answers` round-trips are verified against the running app.
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

- Electron 41, CommonJS, native HTML/CSS/JavaScript, x64 NSIS.
- Artifact: `dist/Vibe-Halo-Setup-0.2.1-x64.exe`.
- Keep `LICENSE`, `NOTICE.md`, and upstream attribution in every release.
- `dist/`, `node_modules/`, `.smoke/`, logs, and contributor-local `AGENTS.local.md` are not committed.
- After moving source or installing a different build, run integration repair and review changed Codex Hook commands in `/hooks`.
