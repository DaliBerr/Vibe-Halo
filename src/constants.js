"use strict";

const os = require("os");
const path = require("path");

const APP_NAME = "Vibe Halo";
const APP_ID = "com.vibe.halo";
const SERVER_ID = "vibe-halo";
const SERVER_HEADER = "x-vibe-halo";
const TOKEN_HEADER = "x-vibe-halo-token";
const RUNTIME_DIR = process.env.VIBE_HALO_RUNTIME_DIR || path.join(os.homedir(), ".vibe-halo");
const RUNTIME_PATH = path.join(RUNTIME_DIR, "runtime.json");
const MIGRATION_PATH = path.join(RUNTIME_DIR, "hook-migration.json");
const BACKUP_DIR = path.join(RUNTIME_DIR, "backups");
const BODY_LIMIT = 256 * 1024;
const APPROVAL_TIMEOUT_MS = 120_000;
const HOOK_HTTP_TIMEOUT_MS = 130_000;
const HOOK_TIMEOUT_SECONDS = 150;
const EVENT_TIMEOUT_SECONDS = 30;
const COMPLETION_TIMEOUT_MS = 8_000;
const INPUT_REMINDER_TIMEOUT_MS = 30 * 60_000;
const CODEX_INPUT_POLL_INTERVAL_MS = 1_000;
const CODEX_INPUT_RESCAN_INTERVAL_MS = 5_000;
const CODEX_INPUT_RECOVERY_MAX_AGE_MS = 30 * 60_000;
const OWN_HOOK_MARKER = "vibe-halo-hook.js";
const OWN_RUNNER_MARKER = "vibe-halo-hook-runner";
const PREVIOUS_HOOK_MARKER = "clawd-island-hook.js";
const LEGACY_HOOK_MARKER = "codex-hook.js";
const MANAGED_EVENTS = Object.freeze(["PermissionRequest", "Stop", "UserPromptSubmit"]);
const LEGACY_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
]);

module.exports = {
  APP_NAME,
  APP_ID,
  SERVER_ID,
  SERVER_HEADER,
  TOKEN_HEADER,
  RUNTIME_DIR,
  RUNTIME_PATH,
  MIGRATION_PATH,
  BACKUP_DIR,
  BODY_LIMIT,
  APPROVAL_TIMEOUT_MS,
  HOOK_HTTP_TIMEOUT_MS,
  HOOK_TIMEOUT_SECONDS,
  EVENT_TIMEOUT_SECONDS,
  COMPLETION_TIMEOUT_MS,
  INPUT_REMINDER_TIMEOUT_MS,
  CODEX_INPUT_POLL_INTERVAL_MS,
  CODEX_INPUT_RESCAN_INTERVAL_MS,
  CODEX_INPUT_RECOVERY_MAX_AGE_MS,
  OWN_HOOK_MARKER,
  OWN_RUNNER_MARKER,
  PREVIOUS_HOOK_MARKER,
  LEGACY_HOOK_MARKER,
  MANAGED_EVENTS,
  LEGACY_EVENTS,
};
