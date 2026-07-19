"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalStore } = require("../src/approval-store");
const { IntegrationManager, readJson } = require("../src/integration-manager");
const { createPlatformAdapter } = require("../src/platform-adapter");
const { IslandServer } = require("../src/server");

const HOOK_SCRIPT = path.resolve(__dirname, "..", "hooks", "vibe-halo-hook.js");
const roots = [];
const servers = [];
test.afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runHook(runtimeDir, payload, agentId = "codex") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, "--agent", agentId], {
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

function runProcessHook(entry, runtimeDir, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, {
      env: { ...process.env, VIBE_HALO_RUNTIME_DIR: runtimeDir },
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) return reject(new Error(`process hook exited ${code}: ${Buffer.concat(stderr)}`));
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function installZcodeHooks(root) {
  const home = path.join(root, "home");
  const configPath = path.join(home, ".zcode", "cli", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{}\n");
  const manager = new IntegrationManager({
    homeDir: home,
    backupRoot: path.join(root, "backups"),
    executablePath: process.execPath,
    hookScriptPath: HOOK_SCRIPT,
  });
  assert.equal(manager.install("zcode").ok, true);
  return readJson(configPath).hooks.events;
}

// Process-hook startup can be delayed when Windows CI is concurrently
// rebuilding and packaging Electron. Keep this comfortably below the hook's
// protocol timeout while avoiding a machine-load-dependent false failure.
function waitFor(predicate, timeoutMs = 20_000) {
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

test("installed ZCode process hooks run without a shell and deliver every managed event", {
  skip: process.platform !== "win32",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-zcode-process-"));
  roots.push(root);
  const approvals = new ApprovalStore({ timeoutMs: 10_000 });
  const events = [];
  const server = new IslandServer({
    approvalStore: approvals,
    runtimePath: path.join(root, "runtime.json"),
    onEvent: event => events.push(event),
  });
  await server.start();
  servers.push(server);
  const installed = installZcodeHooks(root);
  const managedEntry = event => installed[event].find(item => item.hooks?.[0]?.command === "cmd.exe");
  const entry = event => managedEntry(event).hooks[0];

  assert.equal(managedEntry("PermissionRequest").matcher, undefined);
  assert.equal(managedEntry("SessionStart").matcher, undefined);

  const permission = runProcessHook(entry("PermissionRequest"), root, {
    session_id: "zcode-process",
    request_id: "permission-1",
    tool_name: "Shell",
    tool_input: { command: "dir" },
  });
  await waitFor(() => approvals.size === 1);
  approvals.resolve(approvals.current.id, "allow");
  assert.deepEqual(JSON.parse(await permission), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });

  // ZCode reads the decision from a child-process pipe. Exercise repeated real
  // process exits so stdout must be flushed before the managed Hook terminates.
  for (let index = 0; index < 5; index += 1) {
    const repeated = runProcessHook(entry("PermissionRequest"), root, {
      session_id: "zcode-process",
      request_id: `permission-repeat-${index}`,
      tool_name: "Shell",
      tool_input: { command: "dir" },
    });
    await waitFor(() => approvals.size === 1);
    approvals.resolve(approvals.current.id, "allow");
    assert.deepEqual(JSON.parse(await repeated), {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  }

  const questions = [{ header: "方案", question: "选择哪个方案？", options: [
    { label: "方案 A", description: "保守" },
    { label: "方案 B", description: "均衡" },
    { label: "方案 C", description: "激进" },
  ] }];
  const question = runProcessHook(entry("PermissionRequest"), root, {
    session_id: "zcode-process",
    request_id: "question-1",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
  });
  await waitFor(() => approvals.size === 1);
  assert.equal(approvals.current.kind, "elicitation");
  assert.deepEqual(approvals.current.questions[0].options.map(option => option.label), ["方案 A", "方案 B", "方案 C"]);
  approvals.resolve(approvals.current.id, "submit", { answers: { question_1: "option_2" } });
  assert.deepEqual(JSON.parse(await question), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: { questions, answers: { "选择哪个方案？": "方案 B" } },
      },
    },
  });

  for (const event of ["UserPromptSubmit", "Stop", "SessionStart"]) {
    assert.equal(await runProcessHook(entry(event), root, { session_id: `zcode-${event}` }), "");
  }
  await waitFor(() => events.length === 3);
  assert.deepEqual(events.map(event => event.event), ["UserPromptSubmit", "Stop", "UserPromptSubmit"]);
  assert.deepEqual(events.map(event => event.agentId), ["zcode", "zcode", "zcode"]);

  const offlineRoot = path.join(root, "offline");
  fs.mkdirSync(offlineRoot, { recursive: true });
  assert.equal(await runProcessHook(entry("PermissionRequest"), offlineRoot, {
    session_id: "zcode-offline",
    request_id: "permission-offline",
    tool_name: "Shell",
    tool_input: { command: "dir" },
  }), "{}");
});

test("installed POSIX runner uses a stable path and returns a decision without a shell", {
  skip: process.platform === "win32",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-halo-posix-runner-"));
  roots.push(root);
  const home = path.join(root, "home");
  const runtimeDir = path.join(root, "runtime");
  const configPath = path.join(home, ".zcode", "cli", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{}\n");
  const platformAdapter = createPlatformAdapter({
    platform: process.platform,
    homeDir: home,
    runtimeRoot: runtimeDir,
    executablePath: process.execPath,
    packaged: true,
  });
  platformAdapter.prepareHookRuntime(HOOK_SCRIPT);
  const manager = new IntegrationManager({
    platform: process.platform,
    platformAdapter,
    homeDir: home,
    backupRoot: path.join(root, "backups"),
    executablePath: process.execPath,
    hookScriptPath: platformAdapter.managedHookPath,
  });
  assert.equal(manager.install("zcode").ok, true);
  const hook = readJson(configPath).hooks.events.PermissionRequest[0].hooks[0];
  assert.equal(hook.command, platformAdapter.runnerPath);
  assert.deepEqual(hook.args, ["--agent", "zcode", "--event", "PermissionRequest"]);

  const approvals = new ApprovalStore({ timeoutMs: 10_000 });
  const server = new IslandServer({ approvalStore: approvals, runtimePath: path.join(runtimeDir, "runtime.json") });
  await server.start();
  servers.push(server);
  const outputPromise = runProcessHook(hook, runtimeDir, {
    session_id: "posix-e2e",
    request_id: "permission-posix",
    tool_name: "Shell",
    tool_input: { command: "printf safe" },
  });
  await waitFor(() => approvals.size === 1);
  approvals.resolve(approvals.current.id, "allow");
  assert.deepEqual(JSON.parse(await outputPromise), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
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
