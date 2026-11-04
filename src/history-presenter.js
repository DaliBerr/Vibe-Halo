"use strict";

const { agent } = require("./agent-registry");
const { formatApprovalInput } = require("./approval-presenter");
const { truncateUtf8 } = require("./history-store");
const { translateReason } = require("./i18n");

const COPY_SECTIONS = new Set(["primary", "parameters", "answers", "content", "cwd"]);
const HISTORY_MAX_DETAIL_IPC_BYTES = 256 * 1024;
const HISTORY_MAX_LIST_IPC_BYTES = 1024 * 1024;

function validId(value) {
  return typeof value === "string" && /^[0-9a-f-]{16,80}$/i.test(value);
}

function localizeValue(localization, value, key, params) {
  return value || (key ? localization.t(key, params) : "");
}

function outcomeKey(record) {
  if (record.reason === "timeout" || record.reason === "expired") return "outcomeTimeout";
  if (record.reason === "all-waiters-disconnected" || record.reason === "disconnected") return "outcomeDisconnected";
  if (record.reason === "dismissed") return "outcomeDismissed";
  if (["user-closed", "window-close", "shutdown", "cleared", "disabled"].includes(record.reason)) return "outcomeClosed";
  if (record.outcome === "allow" || record.outcome === "always") return "outcomeAllow";
  if (record.outcome === "deny") return "outcomeDeny";
  if (record.outcome === "submit" || record.outcome === "answered") return "outcomeSubmit";
  if (record.outcome === "native") return "outcomeNative";
  if (record.outcome === "ready") return "outcomeReady";
  if (["answered", "session-stopped", "new-prompt"].includes(record.reason)) return "outcomeCompleted";
  return "outcomeUnknown";
}

function localizeRecord(localization, record) {
  const descriptor = agent(record.agentId);
  const title = localizeValue(localization, record.title, record.titleKey, record.titleParams);
  const outcomeLabel = localizeValue(localization, record.outcomeLabel, record.outcomeLabelKey, record.outcomeLabelParams)
    || localization.historyStrings()[outcomeKey(record)];
  return {
    ...record,
    title,
    outcomeLabel,
    reasonLabel: translateReason(localization, record.reason),
    agentAppearance: descriptor?.appearance || {
      glyph: "A", accent: "#64748B", inkLight: "#334155", inkDark: "#CBD5E1",
    },
  };
}

function historyListState(store, localization, nativeTheme) {
  const snapshot = store.snapshot();
  const state = {
    locale: localization.locale,
    theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    strings: localization.historyStrings(),
    storage: {
      count: snapshot.count,
      mode: snapshot.mode,
      retentionDays: snapshot.retentionDays,
      maxEntries: snapshot.maxEntries,
    },
    items: store.list().map(record => localizeRecord(localization, record)),
  };
  while (state.items.length && Buffer.byteLength(JSON.stringify(state), "utf8") > HISTORY_MAX_LIST_IPC_BYTES) state.items.pop();
  return state;
}

function historyDetail(store, localization, id) {
  const record = store.get(id);
  if (!record) return null;
  const localized = localizeRecord(localization, record);
  const t = (key, params) => localization.t(key, params);
  let presentation = null;
  if (record.kind === "approval" || (record.kind === "question" && Object.keys(record.toolInput || {}).length)) {
    presentation = formatApprovalInput(record.toolInput, record.description, t);
    const primaryKey = ["command", "cmd", "script", "patch", "diff", "query", "search_query", "prompt", "question", "url", "uri", "file_path", "path", "input", "text"]
      .find(key => typeof record.toolInput?.[key] === "string" && record.toolInput[key]);
    const raw = JSON.stringify(record.toolInput || {}, null, 2);
    presentation = {
      ...presentation,
      primary: primaryKey ? record.toolInput[primaryKey] : presentation.primary,
      copyText: primaryKey ? record.toolInput[primaryKey] : raw,
      raw,
      hasRaw: raw !== "{}",
    };
    delete presentation.copyText;
  }
  const content = localizeValue(localization, record.content, record.contentKey, record.contentParams);
  const detail = {
    ...localized,
    toolInput: undefined,
    presentation,
    content,
    answersText: Object.keys(record.answers || {}).length ? JSON.stringify(record.answers, null, 2) : "",
  };
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") > HISTORY_MAX_DETAIL_IPC_BYTES) {
    const overflow = Buffer.byteLength(JSON.stringify(detail), "utf8") - HISTORY_MAX_DETAIL_IPC_BYTES;
    if (detail.presentation?.raw) detail.presentation.raw = truncateUtf8(detail.presentation.raw, Math.max(0, Buffer.byteLength(detail.presentation.raw, "utf8") - overflow - 1024));
    detail.truncated = true;
  }
  return detail;
}

function copyValue(detail, section) {
  if (!detail || !COPY_SECTIONS.has(section)) return "";
  if (section === "primary") return detail.presentation?.primary || "";
  if (section === "parameters") return detail.presentation?.raw || "";
  if (section === "answers") return detail.answersText || "";
  if (section === "content") return detail.content || "";
  if (section === "cwd") return detail.cwd || "";
  return "";
}

module.exports = {
  COPY_SECTIONS,
  HISTORY_MAX_DETAIL_IPC_BYTES,
  HISTORY_MAX_LIST_IPC_BYTES,
  copyValue,
  historyDetail,
  historyListState,
  outcomeKey,
  validId,
};
