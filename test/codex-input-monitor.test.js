"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexInputMonitor, normalizeQuestions } = require("../src/codex-input-monitor");

function record(type, payload, timestamp = new Date().toISOString()) {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-input-monitor-"));
  const sessionsDir = path.join(root, "sessions", "2026", "07", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, "rollout-2026-07-18T10-00-00-019f0000-1111-2222-3333-444444444444.jsonl");
  const requested = [];
  const resolved = [];
  const monitor = new CodexInputMonitor({
    sessionsDir: path.join(root, "sessions"),
    recoveryMaxAgeMs: 60_000,
    onRequested: item => { requested.push(item); return true; },
    onResolved: item => resolved.push(item),
  });
  return { root, filePath, monitor, requested, resolved };
}

test("detects exact request_user_input and clears it on matching output", () => {
  const { root, filePath, monitor, requested, resolved } = fixture();
  try {
    fs.writeFileSync(filePath,
      record("session_meta", { session_id: "thread-1", cwd: "C:\\Work\\Demo" })
      + record("response_item", {
        type: "function_call",
        name: "request_user_input",
        call_id: "call-1",
        arguments: JSON.stringify({ questions: [{
          header: "界面测试",
          id: "surface",
          question: "你看到了什么？",
          options: [{ label: "Codex 原生界面", description: "在 Codex 内回答" }],
        }] }),
      }), "utf8");

    monitor.scanNow(true);
    assert.equal(requested.length, 1);
    assert.equal(requested[0].sessionId, "thread-1");
    assert.equal(requested[0].cwd, "C:\\Work\\Demo");
    assert.equal(requested[0].title, "界面测试");
    assert.match(requested[0].content, /Codex 原生界面/);

    fs.appendFileSync(filePath, record("response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ answers: { surface: { answers: ["Codex 原生界面"] } } }),
    }), "utf8");
    monitor.scanNow();
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].requestKey, requested[0].requestKey);
    assert.equal(monitor.status().pendingCount, 0);
  } finally {
    monitor.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not flash for resolved history or text that merely mentions the tool", () => {
  const { root, filePath, monitor, requested } = fixture();
  try {
    fs.writeFileSync(filePath,
      record("response_item", { type: "message", role: "developer", content: "Use request_user_input when needed" })
      + record("response_item", {
        type: "function_call",
        name: "request_user_input",
        call_id: "call-done",
        arguments: JSON.stringify({ questions: [] }),
      })
      + record("response_item", { type: "function_call_output", call_id: "call-done", output: "{}" }), "utf8");
    monitor.scanNow(true);
    assert.equal(requested.length, 0);
    assert.equal(monitor.status().pendingCount, 0);
  } finally {
    monitor.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waits for a complete JSONL line and can replay while reminders are disabled", () => {
  const { root, filePath } = fixture();
  const requested = [];
  let enabled = false;
  const monitor = new CodexInputMonitor({
    sessionsDir: path.join(root, "sessions"),
    recoveryMaxAgeMs: 60_000,
    onRequested: item => {
      if (!enabled) return false;
      requested.push(item);
      return true;
    },
  });
  try {
    const line = record("response_item", {
      type: "function_call",
      name: "request_user_input",
      call_id: "call-partial",
      arguments: JSON.stringify({ questions: [{ question: "继续吗？" }] }),
    }).trimEnd();
    fs.writeFileSync(filePath, line, "utf8");
    monitor.scanNow(true);
    assert.equal(requested.length, 0);
    fs.appendFileSync(filePath, "\n", "utf8");
    monitor.scanNow();
    assert.equal(requested.length, 0);
    enabled = true;
    monitor.replayPending();
    assert.equal(requested.length, 1);
    monitor.replayPending();
    assert.equal(requested.length, 1);
  } finally {
    monitor.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("question normalization is bounded and rejects malformed arguments", () => {
  assert.deepEqual(normalizeQuestions("not-json"), []);
  const questions = normalizeQuestions(JSON.stringify({ questions: new Array(5).fill({
    header: "h".repeat(100),
    question: "q",
    options: new Array(8).fill({ label: "option" }),
  }) }));
  assert.equal(questions.length, 3);
  assert.equal(questions[0].header.length, 80);
  assert.equal(questions[0].options.length, 4);
});
