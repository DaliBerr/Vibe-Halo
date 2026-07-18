# AGENTS.md

For contributor-specific workflow and communication preferences, see `AGENTS.local.md` when it exists. This local guide is intentionally not tracked.

## Project Scope

Vibe Halo is a Windows-first dynamic-island interface for AI coding clients. It provides fail-open approvals, exact protocol-backed interactive answers where supported, native-flow reminders, and completion notifications.

The project supports 19 integrations through a shared adapter registry while preserving a single window and one global approval FIFO. It does not include desktop pets, remote approvals, a theme system, or automatic updates. Do not reintroduce the Clawd on Desk pet, remote-approval, or multi-agent state-machine features unless explicitly requested.

## Repository Entry Points

- `src/main.js`: Electron lifecycle, tray menu, stores, and service wiring.
- `src/agent-registry.js`: client capabilities, event normalization, bounded forms, and exact decision codecs.
- `src/integration-manager.js`: detection, incremental installation, backups, health, repair, and safe removal.
- `hooks/vibe-halo-hook.js`: self-contained generic command hook and sanitized client stdout decisions.
- `hooks/integrations/`: managed OpenCode, Hermes, Pi, and OpenClaw plugin assets.
- `src/server.js`: loopback-only authenticated hook server.
- `src/approval-store.js`: global approval FIFO, deduplication, timeout, disconnect, and idempotent decisions.
- `src/codex-input-monitor.js`: read-only incremental monitor for Codex session JSONL files.
- `src/input-request-store.js` and `src/completion-store.js`: reminder and completion-notification lifecycles.
- `src/island-controller.js`: the single `BrowserWindow`, event priority, positioning, IPC, sizing, and animation.
- `src/renderer/`: native HTML, CSS, and JavaScript UI.
- `src/hook-manager.js`: Codex-specific trust-aware hook installation and migration.
- `test/`: protocol, store, server, hook, IPC, positioning, and window-layout tests.
