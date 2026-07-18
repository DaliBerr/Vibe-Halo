"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalStore } = require("../src/approval-store");
const { BODY_LIMIT, SERVER_HEADER, SERVER_ID, TOKEN_HEADER } = require("../src/constants");
const { IslandServer } = require("../src/server");

const roots = [];
const servers = [];

test.afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-server-"));
  roots.push(root);
  const approvals = new ApprovalStore({ timeoutMs: 60_000 });
  const events = [];
  const server = new IslandServer({
    approvalStore: approvals,
    runtimePath: path.join(root, "runtime.json"),
    isApprovalEnabled: options.isApprovalEnabled || (() => true),
    onEvent: value => events.push(value),
  });
  await server.start();
  servers.push(server);
  return { approvals, events, server, root };
}

function request(server, route, body, options = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: server.port,
      path: route,
      method: options.method || "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(raw),
        [TOKEN_HEADER]: options.token === undefined ? server.token : options.token,
      },
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

function permission(overrides = {}) {
  return {
    event: "PermissionRequest",
    agent_id: "codex",
    session_id: "codex:s1",
    tool_use_id: "tool-1",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_input_fingerprint: "abc",
    codex_session_role: "main",
    ...overrides,
  };
}

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timeout"));
      setImmediate(check);
    };
    check();
  });
}

test("requires the process-lifetime token", async () => {
  const { server } = await fixture();
  const response = await request(server, "/permission", permission(), { token: "wrong-token" });
  assert.equal(response.status, 401);
  assert.equal(response.headers[SERVER_HEADER], SERVER_ID);
});

test("queues and resolves an authenticated permission", async () => {
  const { approvals, server } = await fixture();
  const pending = request(server, "/permission", permission());
  await waitFor(() => approvals.size === 1);
  assert.equal(approvals.resolve(approvals.current.id, "allow"), true);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).hookSpecificOutput.decision.behavior, "allow");
});

test("fans duplicate HTTP requests into one approval", async () => {
  const { approvals, server } = await fixture();
  const left = request(server, "/permission", permission());
  const right = request(server, "/permission", permission());
  await waitFor(() => approvals.size === 1 && approvals.current.waiters.size === 2);
  approvals.resolve(approvals.current.id, "deny");
  const responses = await Promise.all([left, right]);
  assert.deepEqual(responses.map(item => JSON.parse(item.body).hookSpecificOutput.decision.behavior), ["deny", "deny"]);
});

test("headless, disabled and oversized permissions fail open", async () => {
  const first = await fixture();
  const headless = await request(first.server, "/permission", permission({ codex_session_role: "subagent" }));
  assert.equal(headless.body, "{}");
  assert.equal(first.approvals.size, 0);

  const second = await fixture({ isApprovalEnabled: () => false });
  const disabled = await request(second.server, "/permission", permission({ tool_use_id: "tool-2" }));
  assert.equal(disabled.body, "{}");

  const oversized = await request(second.server, "/permission", `{"agent_id":"codex","padding":"${"x".repeat(BODY_LIMIT)}"}`);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body, "{}");
});

test("accepts completion events and cleans its runtime file", async () => {
  const { events, root, server } = await fixture();
  const response = await request(server, "/event", { event: "Stop", agent_id: "codex", session_id: "s1" });
  assert.equal(response.status, 204);
  assert.equal(events.length, 1);
  const runtimePath = path.join(root, "runtime.json");
  assert.equal(fs.existsSync(runtimePath), true);
  servers.splice(servers.indexOf(server), 1);
  await server.stop();
  assert.equal(fs.existsSync(runtimePath), false);
});
