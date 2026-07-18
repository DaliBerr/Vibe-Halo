"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalStore } = require("../src/approval-store");
const { IslandServer } = require("../src/server");

const roots = [];
const servers = [];
test.afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runHook(runtimeDir, payload, agentId = "codex") {
const script = path.resolve(__dirname, "..", "hooks", "vibe-halo-hook.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--agent", agentId], {
    env: { ...process.env, VIBE_HALO_RUNTIME_DIR: runtimeDir },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${Buffer.concat(stderr)}`));
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timeout"));
      setTimeout(check, 10);
    };
    check();
  });
}

test("official hook posts a permission and returns the selected decision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-hook-e2e-"));
  roots.push(root);
  const approvals = new ApprovalStore({ timeoutMs: 10_000 });
  const server = new IslandServer({ approvalStore: approvals, runtimePath: path.join(root, "runtime.json") });
  await server.start();
  servers.push(server);

  const outputPromise = runHook(root, {
    hook_event_name: "PermissionRequest",
    session_id: "e2e",
    tool_name: "Bash",
    tool_use_id: "tool-e2e",
    tool_input: { command: "echo hello" },
  });
  await waitFor(() => approvals.size === 1);
  approvals.resolve(approvals.current.id, "allow");
  const output = await outputPromise;
  assert.equal(JSON.parse(output).hookSpecificOutput.decision.behavior, "allow");
});

test("generic command hook handles ZCode and Copilot wire formats", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-hook-multi-"));
  roots.push(root);
  const approvals = new ApprovalStore({ timeoutMs: 10_000 });
  const server = new IslandServer({ approvalStore: approvals, runtimePath: path.join(root, "runtime.json") });
  await server.start();
  servers.push(server);

  const zcodeOutput = runHook(root, {
    hook_event_name: "PermissionRequest", session_id: "z", requestId: "z1",
    tool_name: "Shell", tool_input: { command: "dir" },
  }, "zcode");
  await waitFor(() => approvals.size === 1);
  approvals.resolve(approvals.current.id, "deny");
  assert.equal(JSON.parse(await zcodeOutput).hookSpecificOutput.decision.behavior, "deny");

  const copilotOutput = runHook(root, {
    hook_event_name: "permissionRequest", session_id: "c", requestId: "c1",
    tool_name: "shell", tool_input: { command: "dir" },
  }, "copilot-cli");
  await waitFor(() => approvals.size === 1);
  approvals.resolve(approvals.current.id, "allow");
  assert.deepEqual(JSON.parse(await copilotOutput), { behavior: "allow" });
});

test("clients with empty-stdout fallback remain native when Vibe Halo is offline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-hook-native-"));
  roots.push(root);
  const output = await runHook(root, {
    hook_event_name: "permissionRequest", session_id: "offline", tool_name: "shell", tool_input: {},
  }, "copilot-cli");
  assert.equal(output, "");
});

test("offline official hook immediately returns no-decision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-hook-offline-"));
  roots.push(root);
  const output = await runHook(root, {
    hook_event_name: "PermissionRequest",
    session_id: "offline",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
  });
  assert.equal(output, "{}");
});
