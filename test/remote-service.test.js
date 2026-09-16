"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ApprovalStore } = require("../src/approval-store");
const { DecisionService } = require("../src/decision-service");
const { normalizeRequest } = require("../src/agent-registry");
const { RemoteService } = require("../src/remote/remote-service");
const { detail, contextDigest } = require("../src/remote/event-projector");
const { EventJournal } = require("../src/remote/event-journal");
const { createTlsIdentity } = require("../src/remote/lan-service");

function safeStorage() {
  const key = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    decryptString(value) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"); } };
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-remote-test-"));
  const storage = safeStorage(), approvals = new ApprovalStore(), decisions = new DecisionService({ approvalStore: approvals });
  const remote = new RemoteService({ userData: directory, safeStorage: storage, approvals, decisions, allowLocal: true });
  await remote.initialize();
  remote.state = { version: 1, identity: await remote.crypto.generateIdentity("pc"), bindings: [], relayOrigin: "https://synthetic.invalid", enabled: false, controlEnabled: true };
  remote.enabled = true; decisions.pcId = remote.pcId;
  t.after(async () => { await remote.stop(); approvals.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { remote, approvals, decisions, storage, directory };
}
test("verified encrypted gateway rejects tamper and shares idempotency across transports", async t => {
  const f = await fixture(t), { remote, approvals } = f, c = remote.crypto;
  const mobile = await c.generateIdentity("mobile"); const bindingId = crypto.randomUUID();
  remote.state.bindings.push({ bindingId, revision: 1, state: "active", mobile: await c.publicDevice(mobile), scopes: ["events.read", "approvals.decide"] });
  let executions = 0;
  const entry = approvals.enqueue(normalizeRequest("codex", { event: "PermissionRequest", request_id: "gateway", tool_name: "Bash", tool_input: { command: "echo gateway" } }), { complete: () => executions++ }).entry;
  const intent = { protocolVersion: 1, decisionId: crypto.randomUUID(), bindingId, bindingRevision: 1, mobileId: mobile.deviceId, pcId: remote.pcId,
    pcSessionEpoch: approvals.pcSessionEpoch, eventId: entry.eventId, approvalId: entry.id, expectedRevision: entry.eventRevision, approvalContextDigest: contextDigest(entry), optionId: "allow",
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20000).toISOString() };
  const envelope = await c.seal(intent, mobile.signKey, remote.state.identity.encryptionKey, "decision-intent");
  const message = { decisionId: intent.decisionId, bindingId, bindingRevision: 1, mobileId: mobile.deviceId, envelope };
  const [lan, cloud] = await Promise.all([remote.receiveDecision(message), remote.receiveDecision(message)]);
  for (const reply of [lan, cloud]) assert.equal((await c.open(reply, mobile.encryptionKey, remote.state.identity.signKey, "decision-receipt")).status, "desktop_accepted");
  assert.equal(executions, 1);
  await assert.rejects(remote.receiveDecision({ ...message, envelope: envelope.slice(0, -5) + "AAAAA" }));
  remote.state.bindings[0].state = "revoked";
  await assert.rejects(remote.receiveDecision(message), /forbidden/);
});
test("persistent authority requires a real full preview, local opt-in and explicit phone confirmation", async t => {
  const f = await fixture(t), { approvals, decisions, remote } = f;
  const bindingId = crypto.randomUUID(), mobile = await remote.crypto.generateIdentity("mobile");
  const binding = { bindingId, revision: 1, state: "active", mobile, scopes: ["approvals.decide", "approvals.persistent"], persistentEnabled: false };
  remote.state.bindings.push(binding);
  const entry = approvals.enqueue(normalizeRequest("opencode", { event: "PermissionRequest", request_id: "persistent", tool_name: "bash", tool_input: { command: "echo scope" }, always: true, always_patterns: ["echo *"] }), { complete() {} }).entry;
  const intent = { protocolVersion: 1, decisionId: crypto.randomUUID(), bindingId, bindingRevision: 1, mobileId: mobile.deviceId, pcId: remote.pcId, pcSessionEpoch: approvals.pcSessionEpoch,
    eventId: entry.eventId, approvalId: entry.id, expectedRevision: entry.eventRevision, approvalContextDigest: contextDigest(entry), optionId: "always", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20000).toISOString() };
  assert.equal(decisions.decideVerifiedRemote(intent, bindingId).status, "forbidden");
  binding.persistentEnabled = true;
  assert.equal(decisions.decideVerifiedRemote(intent, bindingId).status, "forbidden");
  const view = detail(entry, { pcId: remote.pcId, pcSessionEpoch: approvals.pcSessionEpoch, currentId: entry.id, pendingCount: 1, now: Date.now(), persistentEnabled: true });
  assert.deepEqual(JSON.parse(view.persistentPreviews.always), { permission: "bash", patterns: ["echo *"] });
  assert.equal(decisions.decideVerifiedRemote({ ...intent, persistentConfirmed: true }, bindingId).status, "desktop_accepted");
});
test("journal is encrypted, bounded and expires previous-process pending requests on restore", async t => {
  const f = await fixture(t), { remote, approvals } = f;
  approvals.enqueue(normalizeRequest("codex", { event: "PermissionRequest", request_id: "journal", tool_name: "Bash", tool_input: { command: "synthetic-private-content" } }), { complete() {} });
  remote.journal.flush(); const text = fs.readFileSync(remote.journal.filePath, "utf8");
  assert.equal(text.includes("synthetic-private-content"), false);
  const restored = new EventJournal({ filePath: remote.journal.filePath, safeStorage: f.storage }); restored.load();
  assert.equal(restored.list()[0].summary.state, "expired"); assert.equal(restored.list()[0].remoteActionable, false);
  fs.writeFileSync(remote.journal.filePath, "damaged");
  const broken = new EventJournal({ filePath: remote.journal.filePath, safeStorage: f.storage }); assert.throws(() => broken.load(), /invalid/); assert.throws(() => broken.flush(), /invalid/);
  assert.equal(fs.readFileSync(remote.journal.filePath, "utf8"), "damaged");
});
test("LAN pin is the actual certificate public key fingerprint", async () => {
  const identity = await createTlsIdentity(); const certificate = new crypto.X509Certificate(identity.certificate);
  assert.equal(crypto.createHash("sha256").update(certificate.publicKey.export({ format: "der", type: "spki" })).digest("base64"), identity.pin);
  assert.equal(certificate.checkPrivateKey(crypto.createPrivateKey(identity.key)), true);
});
test("history requests require their own signature purpose and current read scope", async t => {
  const { remote } = await fixture(t), c = remote.crypto, mobile = await c.generateIdentity("mobile");
  const binding = { bindingId: crypto.randomUUID(), revision: 1, state: "active", mobile: await c.publicDevice(mobile), scopes: ["events.read", "history.read"] };
  remote.state.bindings.push(binding);
  remote.historyStore = { list: () => [{ id: "history-fixture", kind: "approval", agentId: "codex", title: "Synthetic", toolName: "Bash", outcome: "allow", createdAt: Date.now() }], get: () => ({ id: "history-fixture", toolInput: { command: "echo synthetic" } }) };
  const query = { protocolVersion: 1, type: "history.list", relayOrigin: remote.state.relayOrigin, requestId: crypto.randomUUID(), pcId: remote.pcId, mobileId: mobile.deviceId, bindingId: binding.bindingId, bindingRevision: 1, issuedAt: Date.now(), offset: 0 };
  const request = { requestId: query.requestId, mobileId: mobile.deviceId, bindingId: binding.bindingId, bindingRevision: 1, envelope: await c.seal(query, mobile.signKey, remote.state.identity.encryptionKey, "read-request") };
  const result = await c.open(await remote.receiveQuery(request), mobile.encryptionKey, remote.state.identity.signKey, "read-response");
  assert.equal(result.records[0].id, "history-fixture");
  assert.equal(JSON.stringify(result).includes("echo synthetic"), false);
  binding.scopes = ["events.read"]; await assert.rejects(remote.receiveQuery(request), /forbidden/);
});

test("PC confirmation retries the identical persisted grant after a lost relay response", async t => {
  const { remote } = await fixture(t), c = remote.crypto;
  const mobile = await c.generateIdentity("mobile");
  const transcript = { protocolVersion: 1, relayOrigin: remote.state.relayOrigin, pairingId: crypto.randomUUID(), pc: await c.publicDevice(remote.state.identity), mobile: await c.publicDevice(mobile), lanTlsPin: "synthetic-pin", scopes: ["events.read"] };
  remote.pairing = { pairingId: transcript.pairingId, transcript, mobile: transcript.mobile, fingerprint: "SYNTHETIC", expiresAt: Date.now() + 60000 };
  const sent = []; remote.request = async (_route, { body }) => { sent.push(body.grant); if (sent.length === 1) throw new Error("response_lost"); return { state: "active" }; };
  await assert.rejects(remote.confirmPairing("SYNTHETIC"), /response_lost/);
  assert.equal(remote.state.bindings[0].state, "confirming");
  await remote.confirmPairing("SYNTHETIC");
  assert.equal(sent[0], sent[1]); assert.equal(remote.state.bindings.length, 1); assert.equal(remote.state.bindings[0].state, "active");
});

test("reminder dismissal never resolves an approval and requires current local scope", async t => {
  const { remote, approvals } = await fixture(t), c = remote.crypto;
  const { InputRequestStore } = require("../src/input-request-store");
  remote.inputRequests = new InputRequestStore(); t.after(() => remote.inputRequests.clear());
  const mobile = await c.generateIdentity("mobile"), binding = { bindingId: crypto.randomUUID(), revision: 1, state: "active", mobile: await c.publicDevice(mobile), scopes: ["events.read", "reminders.dismiss"] };
  remote.state.bindings.push(binding);
  remote.inputRequests.enqueue({ requestKey: "reminder-test", agentId: "codex", content: "synthetic" });
  const eventId = remote.recordReminder({ requestKey: "reminder-test", agentId: "codex", content: "synthetic" });
  const event = remote.journal.events.get(eventId);
  const query = { protocolVersion: 1, relayOrigin: remote.state.relayOrigin, issuedAt: Date.now(), requestId: crypto.randomUUID(), pcId: remote.pcId, mobileId: mobile.deviceId, bindingId: binding.bindingId, bindingRevision: 1, type: "reminder.dismiss", eventId, pcSessionEpoch: approvals.pcSessionEpoch, eventRevision: event.summary.eventRevision };
  const message = { requestId: query.requestId, mobileId: mobile.deviceId, bindingId: binding.bindingId, bindingRevision: 1, envelope: await c.seal(query, mobile.signKey, remote.state.identity.encryptionKey, "read-request") };
  binding.scopes = ["events.read"]; await assert.rejects(remote.receiveQuery(message), /forbidden/); assert.equal(remote.inputRequests.size, 1);
  binding.scopes.push("reminders.dismiss"); await remote.receiveQuery(message); assert.equal(remote.inputRequests.size, 0); assert.equal(approvals.size, 0); assert.equal(remote.journal.events.get(eventId).summary.state, "resolved");
});
