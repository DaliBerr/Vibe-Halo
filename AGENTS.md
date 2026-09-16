# AGENTS.md

For contributor-specific workflow and communication preferences, see `AGENTS.local.md` when it exists. This local guide is intentionally not tracked.

Use `HANDOFF.md` for dated implementation and verification context, and `README.md` / `README.zh-CN.md` for user-facing behavior. Confirm current behavior against source and tests; historical client versions and test counts are not current guarantees. `package.json`, the lockfile, and release workflows define current dependencies, commands, and packaging.

## Project Scope

Vibe Halo is a Windows, macOS, and Linux dynamic-island interface for AI coding clients. It provides fail-open approvals, exact protocol-backed interactive answers where supported, native-flow reminders, and completion notifications.

The project defines 19 integrations through a shared adapter registry, with different capabilities and verification levels, while preserving one global approval FIFO. Its desktop UI consists of one live top-center island plus one optional, tray-opened recent-event history window. Official Windows stable builds use an explicit-restart, fail-open updater backed by GitHub Releases; local and preview builds disable updates. SignPath is an optional, default-disabled enhancement. An Android notification/remote-approval companion is now explicitly authorized and under staged development; see `docs/REMOTE_DECISIONS.md` and dated HANDOFF evidence. Remote access/control must stay disabled until the relevant authentication, encryption and end-to-end gates pass. Existing system light/dark appearance is supported. Do not reintroduce the Clawd on Desk pet, user-configurable themes or old multi-agent state machine unless explicitly requested.

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
- `src/decision-service.js`: shared current-request validation and default-disabled internal remote decision boundary; network authentication is a separate prerequisite.
- `packages/protocol/` and `src/remote/event-projector.js`: bounded versioned schemas, standalone validators, synthetic fixtures, and explicit network DTO projection.
- `src/codex-input-monitor.js`: read-only incremental monitor for Codex session JSONL files.
- `src/session-origin-store.js`: bounded, expiring in-memory client/Session source information for display placement; never persisted or exposed to renderers.
- `src/completion-event.js`: completion and plan-ready event classification.
- `src/i18n.js`: English/Chinese catalogs, locale resolution, and renderer text.
- `src/input-request-store.js` and `src/completion-store.js`: reminder and completion-notification lifecycles.
- `src/island-controller.js`: the live-island `BrowserWindow`, event priority, positioning, IPC, sizing, and animation.
- `src/renderer/`: native HTML, CSS, and JavaScript UI.
- `src/history-store.js` and `src/history-events.js`: bounded, redacted recent-event persistence and semantic event mapping; encryption uses safeStorage when available, with an explicitly indicated plaintext fallback. Ordinary completion notifications are excluded.
- `src/history-window-controller.js`, `src/history-preload.js`, and `src/history-renderer/`: isolated tray-opened history window, read-only details, constrained copy IPC, and auto-hide lifecycle.
- `src/hook-manager.js`: Codex-specific trust-aware hook installation and migration.
- `electron-builder.config.cjs` and `.github/workflows/`: three-platform preview packaging plus default-unsigned GitHub stable releases with an optional SignPath path.
- `test/`: protocol, store, server, hook, IPC, positioning, and window-layout tests.
