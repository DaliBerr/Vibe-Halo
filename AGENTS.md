# AGENTS.md

For contributor-specific workflow and communication preferences, see `AGENTS.local.md` when it exists. This local guide is intentionally not tracked.

## Project Scope

Vibe Halo is a Windows, macOS, and Linux dynamic-island interface for AI coding clients. It provides fail-open approvals, exact protocol-backed interactive answers where supported, native-flow reminders, and completion notifications.

The project supports 19 integrations through a shared adapter registry while preserving one global approval FIFO. Its desktop UI consists of one live top-center island plus one optional, tray-opened recent-event history window. Official Windows stable builds use an explicit-restart, fail-open updater backed by GitHub Releases; SignPath is an optional, default-disabled enhancement. It does not include desktop pets, remote approvals, or a theme system. Do not reintroduce the Clawd on Desk pet, remote-approval, or multi-agent state-machine features unless explicitly requested.

## Repository Entry Points

- `src/main.js`: Electron lifecycle, tray menu, stores, and service wiring.
- `src/platform-adapter.js`: platform paths, stable Hook launchers, login startup, notifications, and window-backend diagnostics.
- `src/update-manager.js`: main-process-only update state, scheduled checks, download progress, and explicit installation.
- `src/shutdown-coordinator.js`: ordered, idempotent fail-open shutdown used by normal quit and updates.
- `src/agent-registry.js`: client capabilities, event normalization, bounded forms, and exact decision codecs.
- `src/integration-manager.js`: detection, incremental installation, backups, health, repair, and safe removal.
- `hooks/vibe-halo-hook.js`: self-contained generic command hook and sanitized client stdout decisions.
- `hooks/integrations/`: managed OpenCode, Hermes, Pi, and OpenClaw plugin assets.
- `src/server.js`: loopback-only authenticated hook server.
- `src/approval-store.js`: global approval FIFO, deduplication, timeout, disconnect, and idempotent decisions.
- `src/codex-input-monitor.js`: read-only incremental monitor for Codex session JSONL files.
- `src/input-request-store.js` and `src/completion-store.js`: reminder and completion-notification lifecycles.
- `src/island-controller.js`: the live-island `BrowserWindow`, event priority, positioning, IPC, sizing, and animation.
- `src/renderer/`: native HTML, CSS, and JavaScript UI.
- `src/history-store.js` and `src/history-events.js`: bounded, redacted, encrypted-at-rest recent-event persistence and semantic event mapping.
- `src/history-window-controller.js`, `src/history-preload.js`, and `src/history-renderer/`: isolated tray-opened history window, read-only details, constrained copy IPC, and auto-hide lifecycle.
- `src/hook-manager.js`: Codex-specific trust-aware hook installation and migration.
- `electron-builder.config.cjs` and `.github/workflows/`: three-platform preview packaging plus default-unsigned GitHub stable releases with an optional SignPath path.
- `test/`: protocol, store, server, hook, IPC, positioning, and window-layout tests.
