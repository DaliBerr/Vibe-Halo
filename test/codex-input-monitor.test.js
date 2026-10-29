"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CodexInputMonitor,
  normalizeCollaborationMode,
  normalizeCodexSessionId,
  normalizeOutputAnswers,
  normalizeQuestions,
} = require("../src/codex-input-monitor");

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
    assert.equal(requested[0].sessionId, "codex:thread-1");
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
    assert.deepEqual(resolved[0].answers, { surface: ["Codex 原生界面"] });
    assert.equal(resolved[0].answerAvailable, true);
    assert.equal(monitor.status().pendingCount, 0);
  } finally {
    monitor.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounds native Codex answers and safely ignores unknown output shapes", () => {
  assert.deepEqual(normalizeOutputAnswers(JSON.stringify({ answers: { q1: { answers: ["A", "B"] } } })), { q1: ["A", "B"] });
  assert.deepEqual(normalizeOutputAnswers(JSON.stringify({ result: "unknown" })), {});
  assert.deepEqual(normalizeOutputAnswers("not-json"), {});
});

test("reminds in default, plan, and unknown collaboration modes without retaining settings", () => {
  const { root, filePath, monitor, requested } = fixture();
  try {
    fs.writeFileSync(filePath,
      record("session_meta", { session_id: "thread-modes", cwd: "C:\\Work" })
      + record("turn_context", { collaboration_mode: { mode: "default", settings: { developer_instructions: "private" } } })
      + record("response_item", {
        type: "function_call", name: "request_user_input", call_id: "call-default",
        arguments: JSON.stringify({ questions: [{ question: "Default?" }] }),
      }), "utf8");
    monitor.scanNow(true);
    assert.equal(requested.length, 1);
    assert.equal(requested[0].collaborationMode, "default");
    assert.equal(Object.hasOwn(requested[0], "settings"), false);

    fs.appendFileSync(filePath,
      record("response_item", { type: "function_call_output", call_id: "call-default", output: "{}" })
      + record("turn_context", { collaboration_mode: { mode: "plan", settings: { developer_instructions: "private" } } })
      + record("response_item", {
        type: "function_call", name: "request_user_input", call_id: "call-plan",
        arguments: JSON.stringify({ questions: [{ question: "Plan?" }] }),
      }), "utf8");
    monitor.scanNow();
    assert.equal(requested.length, 2);
    assert.equal(requested[1].collaborationMode, "plan");

    fs.appendFileSync(filePath,
      record("response_item", { type: "function_call_output", call_id: "call-plan", output: "{}" })
      + record("turn_context", { collaboration_mode: { mode: "future-mode" } })
      + record("response_item", {
        type: "function_call", name: "request_user_input", call_id: "call-unknown",
        arguments: JSON.stringify({ questions: [{ question: "Unknown?" }] }),
      }), "utf8");
    monitor.scanNow();
    assert.equal(requested.length, 3);
    assert.equal(requested[2].collaborationMode, "unknown");
    assert.equal(monitor.status().lastCollaborationMode, "unknown");
  } finally {
    monitor.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes only supported collaboration mode names", () => {
  assert.equal(normalizeCollaborationMode("DEFAULT"), "default");
  assert.equal(normalizeCollaborationMode({ mode: "plan", settings: { ignored: true } }), "plan");
  assert.equal(normalizeCollaborationMode({ mode: "future" }), "unknown");
  assert.equal(normalizeCollaborationMode(null), "unknown");
});

test("uses the same Codex session namespace as command hooks", () => {
  assert.equal(normalizeCodexSessionId("thread-1"), "codex:thread-1");
  assert.equal(normalizeCodexSessionId("codex:thread-1"), "codex:thread-1");
  assert.equal(normalizeCodexSessionId(""), "codex:unknown");
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

function asyncCall(callId = "async-1", questions = [{ title: "选择输出格式？", options: ["PDF", "Word"] }]) {
  return record("response_item", { type: "function_call", name: "request_user_input_async", call_id: callId,
    arguments: JSON.stringify({ questions }) });
}

function asyncReply(callId, index, answer, role = "user") {
  return record("response_item", { type: "message", role, content: [{ type: "input_text",
    text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", callId, index]), question: "Display text is not an identity", answer }])}\n</send_user_message_question_reply>` }] });
}

test("async acknowledgements keep questions pending across work and turns until every exact reply arrives", () => {
  const { root, filePath, monitor, requested, resolved } = fixture();
  try {
    fs.writeFileSync(filePath, record("session_meta", { id: "thread-async" })
      + asyncCall("async-1", [{ title: "选择输出格式？", options: ["PDF", "Word"] }, { title: "报告面向谁？" }])
      + record("response_item", { type: "function_call_output", call_id: "async-1", output: '{"accepted":true}' }));
    monitor.scanNow(true);
    assert.equal(requested.length, 1);
    assert.match(requested[0].content, /选择输出格式？/);
    assert.match(requested[0].content, /PDF/);
    assert.equal(requested[0].questions[1].options.length, 0);
    assert.deepEqual([...monitor.pendingAsyncRequestKeys("codex:thread-async")], [requested[0].requestKey]);
    assert.equal(monitor.pendingAsyncRequestKeys("codex:other").size, 0);
    fs.appendFileSync(filePath, record("response_item", { type: "function_call_output", call_id: "other-work", output: "done" })
      + record("event_msg", { type: "task_complete" })
      + record("turn_context", { collaboration_mode: { mode: "plan" } })
      + asyncReply("async-1", 1, "工程师"));
    monitor.scanNow();
    assert.equal(resolved.length, 0);
    assert.equal(monitor.status().pendingCount, 1);
    // Duplicate partial replies and polling must not finish or re-notify the request.
    fs.appendFileSync(filePath, asyncReply("async-1", 1, "工程师"));
    monitor.scanNow();
    monitor.replayPending();
    assert.equal(requested.length, 1);
    fs.appendFileSync(filePath, asyncReply("async-1", 0, "PDF"));
    monitor.scanNow();
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].reason, "answered");
    assert.deepEqual(resolved[0].answers, { question_2: "工程师", question_1: "PDF" });
    assert.equal(resolved[0].answerAvailable, true);
    assert.equal(monitor.pendingAsyncRequestKeys("codex:thread-async").size, 0);
  } finally { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("async replies ignore wrong roles, files, calls, indexes, malformed wrappers and empty answers", () => {
  const { root, filePath, monitor, requested, resolved } = fixture();
  try {
    fs.writeFileSync(filePath, asyncCall());
    monitor.scanNow(true);
    const wrongFile = filePath.replace("444444444444", "555555555555");
    fs.writeFileSync(wrongFile, asyncReply("async-1", 0, "PDF"));
    fs.appendFileSync(filePath, asyncReply("async-1", 0, "PDF", "assistant")
      + asyncReply("async-1", -1, "PDF") + asyncReply("async-1", 1, "PDF")
      + asyncReply("async-1", "0", "PDF") + asyncReply("unknown", 0, "PDF")
      + asyncReply("async-1", 0, "   ")
      + record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: '<send_user_message_question_reply>not-json</send_user_message_question_reply>' }] })
      + record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: 'Example: <send_user_message_question_reply>[]</send_user_message_question_reply>' }] }));
    monitor.scanNow(true);
    assert.equal(resolved.length, 0);
    assert.equal(requested.length, 1);
    const reply = asyncReply("async-1", 0, "PDF");
    fs.appendFileSync(filePath, reply.slice(0, -1));
    monitor.scanNow();
    assert.equal(resolved.length, 0);
    fs.appendFileSync(filePath, "\n");
    monitor.scanNow();
    assert.equal(resolved.length, 1);
  } finally { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolved async history and rejected dispatches do not flash a reminder", () => {
  const { root, filePath, monitor, requested } = fixture();
  try {
    fs.writeFileSync(filePath, asyncCall() + record("response_item", { type: "function_call_output", call_id: "async-1", output: '{"accepted":true}' })
      + asyncReply("async-1", 0, "PDF") + asyncCall("rejected")
      + record("response_item", { type: "function_call_output", call_id: "rejected", output: '{"accepted":false}' })
      + asyncCall("invalid", [{ question: "Wrong schema" }]));
    monitor.scanNow(true);
    assert.equal(requested.length, 0);
    assert.equal(monitor.status().pendingCount, 0);
  } finally { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("oversized async forms stay bounded and cannot resolve from a truncated subset", () => {
  const { root, filePath, monitor, requested, resolved } = fixture();
  try {
    fs.writeFileSync(filePath, asyncCall("large", Array.from({ length: 11 }, () => ({ title: "q".repeat(800), options: Array(25).fill("o".repeat(150)) }))));
    monitor.scanNow(true);
    assert.equal(requested[0].questions.length, 10);
    assert.equal(requested[0].questions[0].question.length, 600);
    assert.equal(requested[0].questions[0].options.length, 20);
    assert.equal(requested[0].questions[0].options[0].label.length, 120);
    assert.ok(requested[0].content.length <= 6000);
    fs.appendFileSync(filePath, Array.from({ length: 10 }, (_, i) => asyncReply("large", i, "A")).join(""));
    monitor.scanNow();
    assert.equal(resolved.length, 0);
    assert.equal(monitor.status().pendingCount, 1);
  } finally { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("phone-only deliveries still resolve and async expiry is not reported as answered", () => {
  const { root, filePath, monitor, resolved } = fixture();
  try {
    monitor.onRequested = () => false;
    monitor.onRemoteRequested = () => true;
    fs.writeFileSync(filePath, asyncCall());
    monitor.scanNow(true);
    fs.appendFileSync(filePath, asyncReply("async-1", 0, "PDF"));
    monitor.scanNow();
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].reason, "answered");
    fs.appendFileSync(filePath, asyncCall("expire"));
    monitor.scanNow();
    const createdAt = [...monitor.pending.values()][0].createdAt;
    monitor.now = () => createdAt + monitor.recoveryMaxAgeMs + 1;
    monitor.scanNow();
    assert.equal(resolved.length, 2);
    assert.equal(resolved[1].reason, "expired");
    assert.equal(resolved[1].answerAvailable, false);
    assert.equal(monitor.status().pendingCount, 0);
  } finally { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("remote and desktop delivery retry independently and phone dismissal cannot cause re-delivery", () => {
  const { root, filePath, monitor, requested } = fixture();
  let desktopEnabled = false, phoneEnabled = false, phoneDeliveries = 0;
  monitor.onRequested = request => { if (!desktopEnabled) return false; requested.push(request); return true; };
  monitor.onRemoteRequested = () => { if (!phoneEnabled) return false; phoneDeliveries++; return true; };
  try {
    fs.writeFileSync(filePath, asyncCall());
    monitor.scanNow(true);
    assert.equal(phoneDeliveries, 0);
    phoneEnabled = true;
    monitor.scanNow(); monitor.scanNow(); monitor.replayPending();
    assert.equal(phoneDeliveries, 1);
    assert.equal(requested.length, 0);
    desktopEnabled = true;
    monitor.replayPending();
    assert.equal(requested.length, 1);
    assert.equal(phoneDeliveries, 1);
    // A later request can reach a phone enabled after the local reminder appeared.
    phoneEnabled = false;
    fs.appendFileSync(filePath, asyncCall("later")); monitor.scanNow();
    assert.equal(requested.length, 2);
    phoneEnabled = true; monitor.scanNow();
    assert.equal(phoneDeliveries, 2);
  } finally { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
