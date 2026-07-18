# AGENTS.md

For contributor-specific workflow and communication preferences, see `AGENTS.local.md` when it exists. This local guide is intentionally not tracked.

## Project Scope

Vibe Halo is a Windows-first dynamic-island interface for Codex. It handles approval requests, shows completion notifications, and provides read-only reminders for `request_user_input` calls.

The project currently supports Codex only. It does not include desktop pets, other agent integrations, remote approvals, a theme system, or automatic updates. Do not reintroduce the multi-agent or desktop-pet features from Clawd on Desk unless explicitly requested.

## Repository Entry Points

- `src/main.js`: Electron lifecycle, tray menu, stores, and service wiring.
- `hooks/vibe-halo-hook.js`: self-contained Codex hook, request normalization, and sanitized stdout decisions.
- `src/server.js`: loopback-only authenticated hook server.
- `src/approval-store.js`: global approval FIFO, deduplication, timeout, disconnect, and idempotent decisions.
- `src/codex-input-monitor.js`: read-only incremental monitor for Codex session JSONL files.
- `src/input-request-store.js` and `src/completion-store.js`: reminder and completion-notification lifecycles.
- `src/island-controller.js`: the single `BrowserWindow`, event priority, positioning, IPC, sizing, and animation.
- `src/renderer/`: native HTML, CSS, and JavaScript UI.
- `src/hook-manager.js`: hook installation, backup, migration, health checks, and safe removal.
- `test/`: protocol, store, server, hook, IPC, positioning, and window-layout tests.
