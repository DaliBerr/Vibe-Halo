"use strict";
// Local-only synthetic endpoint for MediaTransferTest. No production accounts or relay state.
const { app, safeStorage } = require("electron");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { RemoteService } = require("../src/remote/remote-service");
const { ApprovalStore } = require("../src/approval-store");
const { DecisionService } = require("../src/decision-service");
const { createTlsIdentity, readBody } = require("../src/remote/lan-service");
const root = path.resolve(__dirname, ".."), origin = "http://127.0.0.1:18787";
fs.mkdirSync(path.join(root, ".smoke"), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, ".smoke/media-e2e-"));
app.setPath("userData", directory); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const approvals = new ApprovalStore(), decisions = new DecisionService({ approvalStore: approvals });
  const remote = new RemoteService({ userData: directory, safeStorage, approvals, decisions, allowLocal: true });
  await remote.initialize(); const c = remote.crypto;
  remote.state = { identity: await c.generateIdentity("pc", "Synthetic image PC"), relayOrigin: origin, bindings: [], enabled: true, enrolled: false, controlEnabled: false, tls: await createTlsIdentity() };
  remote.enabled = true;
  const project = path.join(directory, "project"); fs.mkdirSync(project);
  fs.copyFileSync(path.join(root, "assets/icons/1024x1024.png"), path.join(project, "preview.png"));
  const sourceId = remote.recordReminder({ agentId: "codex", cwd: project, output: "## 图片测试\n\n![预览](preview.png)" }, "completion");
  const bridgeToken = crypto.randomBytes(32).toString("hex");
  const configPath = path.join(root, ".smoke/media-e2e-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ origin, bridgeToken }));
  let binding, challenge, session;
  const server = http.createServer((req, res) => {
    (async () => {
      const input = req.method === "POST" ? await readBody(req) : {};
      let result;
      if (["/setup", "/delete-original", "/shutdown"].includes(req.url)) {
        if (req.headers.authorization !== `Bearer ${bridgeToken}`) throw new Error("unauthorized");
        if (req.url === "/setup") {
          const mobile = await c.publicDevice(input.mobile);
          binding = { bindingId: crypto.randomUUID(), revision: 1, state: "active", mobile, scopes: ["events.read"] }; remote.state.bindings = [binding];
          const grant = { protocolVersion: 1, relayOrigin: origin, pc: await c.publicDevice(remote.state.identity), mobile, bindingId: binding.bindingId, revision: 1,
            spaceId: `space_${remote.pcId}`, lanTlsPin: remote.state.tls.pin, scopes: binding.scopes };
          result = { grant, grantJws: await c.sign(grant, remote.state.identity.signKey, "binding-grant"), sourceId, epoch: approvals.pcSessionEpoch };
        } else if (req.url === "/delete-original") { await remote.media.list(`event:${sourceId}`); fs.rmSync(path.join(project, "preview.png"), { force: true }); result = { deleted: true }; }
        else { await remote.stop(); approvals.shutdown(); result = { stopped: true }; setTimeout(() => server.close(() => app.quit()), 100); }
      } else if (req.url === "/v1/auth/challenge") {
        if (!binding || input.deviceId !== binding.mobile.deviceId) throw new Error("unauthorized");
        challenge = { protocolVersion: 1, relayOrigin: origin, deviceId: input.deviceId, keyId: binding.mobile.signKey.kid, purpose: "device-session", challengeId: crypto.randomUUID(), nonce: crypto.randomUUID(), expiresAt: Date.now() + 60000 };
        result = { challenge };
      } else if (req.url === "/v1/auth/session") {
        if (!challenge || input.challengeId !== challenge.challengeId || c.canonical(await c.verify(input.proof, binding.mobile.signKey, "device-session")) !== c.canonical(challenge)) throw new Error("unauthorized");
        session = crypto.randomBytes(32).toString("hex"); challenge = null; result = { token: session, expiresAt: Date.now() + 600000 };
      } else if (req.url === `/v1/pcs/${remote.pcId}/queries`) {
        if (!session || req.headers.authorization !== `Bearer ${session}`) throw new Error("unauthorized");
        const envelope = await remote.receiveQuery({ ...input, bindingId: binding.bindingId, bindingRevision: binding.revision, mobileId: binding.mobile.deviceId });
        result = { state: "desktop_result", envelope };
      } else throw new Error("not_found");
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    })().catch(() => { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"synthetic_request_failed"}'); });
  });
  server.listen(18787, "127.0.0.1", () => console.log("Local encrypted image fixture ready; credentials withheld."));
}).catch(error => { console.error(error.message); app.exit(1); });
