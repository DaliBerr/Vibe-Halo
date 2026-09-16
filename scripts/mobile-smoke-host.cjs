"use strict";
// Explicit, loopback-only synthetic test harness. Never loaded by the app.
if (process.env.VIBE_HALO_TEST !== "1") throw new Error("Requires VIBE_HALO_TEST=1");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { ApprovalStore } = require("../src/approval-store");
const { DecisionService } = require("../src/decision-service");
const { normalizeRequest, encodeDecision } = require("../src/agent-registry");
const { RemoteService } = require("../src/remote/remote-service");
const { readBody } = require("../src/remote/lan-service");

(async () => {
  const root = path.join(__dirname, ".."); const relay = path.join(root, "services", "relay");
  const relayOrigin = process.env.VIBE_HALO_SMOKE_RELAY_ORIGIN || "http://127.0.0.1:8787";
  const origin = new URL(relayOrigin);
  if (origin.origin !== relayOrigin || origin.username || origin.password || (origin.protocol !== "https:" && relayOrigin !== "http://127.0.0.1:8787")) throw new Error("Use an exact HTTPS relay origin, or the local test relay.");
  let code;
  if (relayOrigin !== "http://127.0.0.1:8787") {
    if (!process.env.VIBE_HALO_SMOKE_ENROLLMENT_FILE) throw new Error("Public synthetic testing requires a separately issued enrollment-code file.");
    code = fs.readFileSync(process.env.VIBE_HALO_SMOKE_ENROLLMENT_FILE, "utf8").split(/\r?\n/)[0].trim();
    if (!/^[A-F0-9]{32}$/.test(code)) throw new Error("Invalid enrollment-code file.");
  } else {
    code = crypto.randomBytes(16).toString("hex").toUpperCase();
    const vars = Object.fromEntries(fs.readFileSync(path.join(relay, ".dev.vars"), "utf8").split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, "")]; }));
    const hmac = crypto.createHmac("sha256", vars.ENROLLMENT_PEPPER).update(code).digest("hex");
    const sql = path.join(root, ".smoke", "mobile-enrollment.sql");
    fs.writeFileSync(sql, `INSERT INTO enrollment_codes(code_hmac,expires_at) VALUES('${hmac}',${Date.now() + 1200000});`);
    execFileSync(process.execPath, [path.join(relay, "node_modules", "wrangler", "bin", "wrangler.js"), "d1", "execute", "DB", "--local", "--file", sql], { cwd: relay, stdio: "pipe", timeout: 30000 });
  }
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptString(value) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"); } };
  const approvals = new ApprovalStore(), decisions = new DecisionService({ approvalStore: approvals });
  const remote = new RemoteService({ userData: fs.mkdtempSync(path.join(root, ".smoke", "mobile-runtime-")), safeStorage, approvals, decisions, allowLocal: true, lanOptions: { advertise: false } });
  await remote.initialize(); await remote.configure({ relayOrigin, enrollmentCode: code, name: "Synthetic PC" });
  remote.setControl(true); await remote.beginPairing();
  const bridgeToken = crypto.randomBytes(32).toString("hex"), outputs = [];
  const fixture = { relayOrigin, bridgeOrigin: "http://127.0.0.1:8788", bridgeToken, code: remote.pairing.code, pcId: remote.pcId, lanPort: remote.lan?.port };
  fs.writeFileSync(path.join(root, ".smoke", "mobile-smoke-config.json"), JSON.stringify(fixture));
  const server = http.createServer((request, response) => {
    (async () => {
      if (request.headers.authorization !== `Bearer ${bridgeToken}`) throw new Error("unauthorized");
      const input = request.method === "POST" ? await readBody(request, 16384) : {};
      let result = {};
      if (request.url === "/confirm") {
        await remote.pollPairing();
        if (remote.pairing.fingerprint !== input.fingerprint) throw new Error("fingerprint_mismatch");
        await remote.confirmPairing(input.fingerprint); result = { confirmed: true };
      } else if (request.url === "/request") {
        const question = input.kind === "question";
        const agent = question ? "hermes" : "codex";
        const questions = [
          { id: "environment", question: "选择测试环境", allowText: false, options: [{ id: "dev", label: "开发" }, { id: "test", label: "测试" }] },
          { id: "checks", question: "选择验证项", multiSelect: true, allowText: false, options: [{ id: "unit", label: "单元" }, { id: "flow", label: "流程" }] },
          { id: "note", question: "补充说明", allowText: true, options: [] }
        ];
        const normalized = normalizeRequest(agent, question
          ? { event: "Elicitation", request_id: crypto.randomUUID(), questions, tool_name: "clarify", tool_input: { questions } }
          : { event: "PermissionRequest", request_id: crypto.randomUUID(), tool_name: "Bash", tool_input: { command: "echo synthetic-mobile-test" } });
        const entry = approvals.enqueue(normalized, { complete: value => outputs.push({ ...value, encoded: JSON.parse(encodeDecision(agent, value, normalized) || "null") }) }).entry;
        await remote.publishAll(); result = { eventId: entry.eventId };
      } else if (request.url === "/cloud-disconnect") { remote.connect = () => {}; remote.socket?.terminate(); result = { disconnected: true }; }
      else if (request.url === "/status") result = { outputs: outputs.map(value => ({ optionId: value.optionId, encoded: value.encoded })), pending: approvals.size, remoteStatus: remote.status };
      else if (request.url === "/revoke") { for (const binding of remote.state.bindings) if (binding.state === "active") await remote.revoke(binding.bindingId); result = { revoked: true }; }
      else if (request.url === "/shutdown") { await remote.stop(); approvals.shutdown(); result = { stopped: true }; setTimeout(() => server.close(), 100); }
      else throw new Error("not_found");
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
    })().catch(error => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message })); });
  });
  server.listen(8788, "127.0.0.1", () => console.log("Synthetic desktop/relay bridge ready; credentials withheld."));
  process.on("SIGINT", async () => { await remote.stop(); approvals.shutdown(); server.close(); });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
