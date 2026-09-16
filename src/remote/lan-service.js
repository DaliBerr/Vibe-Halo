"use strict";

const https = require("node:https");
const { randomBytes, randomUUID, createHash, webcrypto } = require("node:crypto");
const { WebSocketServer } = require("ws");
const { Bonjour } = require("bonjour-service");
const { safeTree } = require("../../packages/protocol");

async function createTlsIdentity() {
  require("reflect-metadata");
  const x509 = require("@peculiar/x509");
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"), name: "CN=Vibe Halo Companion", keys,
    notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + 5 * 365 * 86400000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
  }, webcrypto);
  const key = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey));
  return { certificate: certificate.toString("pem"), key: `-----BEGIN PRIVATE KEY-----\n${key.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`, pin: createHash("sha256").update(spki).digest("base64") };
}
async function readBody(request, limit = 262144) {
  const parts = []; let bytes = 0;
  for await (const part of request) { bytes += part.length; if (bytes > limit) throw new Error("too_large"); parts.push(part); }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  if (!safeTree(value) || !value || Array.isArray(value)) throw new Error("invalid_structure");
  return value;
}
class LanService {
  constructor(remote, { host = "0.0.0.0", port = 0, advertise = true } = {}) {
    this.remote = remote; this.host = host; this.port = port; this.advertise = advertise;
    this.challenges = new Map(); this.sessions = new Map(); this.rates = new Map();
  }
  binding(id) {
    const binding = this.remote.state?.bindings.find(value => value.bindingId === id && value.state === "active");
    if (!this.remote.enabled || !binding || !binding.scopes.includes("events.read")) throw new Error("forbidden");
    return binding;
  }
  authenticate(request) {
    const token = (request.headers.authorization || "").replace(/^Bearer /, "");
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) throw new Error("unauthorized");
    const binding = this.binding(session.bindingId);
    if (binding.revision !== session.revision) throw new Error("forbidden");
    return binding;
  }
  async start() {
    if (this.server) return;
    this.server = https.createServer({ key: this.remote.state.tls.key, cert: this.remote.state.tls.certificate, minVersion: "TLSv1.2", requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => {
      this.handle(req).then(value => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); })
        .catch(error => { if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: ["unauthorized", "forbidden", "expired", "too_large", "rate_limited"].includes(error.message) ? error.message : "invalid_request" })); });
    });
    this.server.maxConnections = 64;
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
    this.server.on("upgrade", (request, socket, head) => {
      try {
        if (request.url !== "/v1/stream") throw new Error();
        const binding = this.authenticate(request);
        this.sockets.handleUpgrade(request, socket, head, client => { client.bindingId = binding.bindingId; client.request = request; client.on("error", () => {}); client.on("message", () => client.close(1008)); });
      } catch { socket.destroy(); }
    });
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.port, this.host, resolve); });
    this.port = this.server.address().port;
    if (this.advertise) {
      this.bonjour = new Bonjour();
      this.bonjour.on?.("error", () => {});
      this.advertisement = this.bonjour.publish({ name: `Vibe Halo ${this.remote.pcId}`, type: "vibe-halo", protocol: "tcp", port: this.port, txt: { v: "1", pc: this.remote.pcId } });
      this.advertisement.on("error", () => {});
    }
    this.timer = setInterval(() => this.notify(), 30000); this.timer.unref();
  }
  async handle(request) {
    const now = Date.now();
    for (const map of [this.challenges, this.sessions, this.rates]) for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
    const address = request.socket.remoteAddress || "unknown";
    const rate = this.rates.get(address) || { count: 0, expiresAt: now + 60000 };
    if (this.rates.size >= 128 && !this.rates.has(address) || ++rate.count > 120) throw new Error("rate_limited");
    this.rates.set(address, rate);
    const route = new URL(request.url, "https://localhost").pathname;
    if (route === "/v1/auth/challenge" && request.method === "POST") {
      const input = await readBody(request, 16384), binding = this.binding(input.bindingId);
      if (binding.mobile.deviceId !== input.mobileId || this.challenges.size >= 64) throw new Error("forbidden");
      const challenge = { protocolVersion: 1, relayOrigin: this.remote.state.relayOrigin, purpose: "lan-session", pcId: this.remote.pcId,
        bindingId: binding.bindingId, mobileId: binding.mobile.deviceId, bindingRevision: binding.revision,
        challengeId: randomUUID(), nonce: randomBytes(32).toString("base64url"), tlsPin: this.remote.state.tls.pin, expiresAt: now + 30000 };
      this.challenges.set(challenge.challengeId, challenge); return { challenge };
    }
    if (route === "/v1/auth/session" && request.method === "POST") {
      const input = await readBody(request, 16384), challenge = this.challenges.get(input.challengeId);
      if (!challenge || challenge.expiresAt <= now) throw new Error("expired");
      const binding = this.binding(challenge.bindingId);
      const proof = await this.remote.crypto.verify(input.proof, binding.mobile.signKey, "lan-session");
      if (this.remote.crypto.canonical(proof) !== this.remote.crypto.canonical(challenge)) throw new Error("forbidden");
      if (!this.challenges.delete(challenge.challengeId) || this.sessions.size >= 64) throw new Error("forbidden");
      const token = randomBytes(32).toString("base64url"), expiresAt = now + 300000;
      this.sessions.set(token, { bindingId: binding.bindingId, revision: binding.revision, expiresAt });
      return { token, expiresAt };
    }
    const binding = this.authenticate(request);
    if (route === "/v1/events" && request.method === "GET") {
      const offset = Number(new URL(request.url, "https://localhost").searchParams.get("offset") || 0);
      return this.remote.eventsFor(binding, offset);
    }
    if (route === "/v1/decisions" && request.method === "POST") {
      const input = await readBody(request);
      const envelope = await this.remote.receiveDecision({ ...input, mobileId: binding.mobile.deviceId, bindingId: binding.bindingId, bindingRevision: binding.revision });
      return { state: "desktop_result", envelope };
    }
    if (route === "/v1/queries" && request.method === "POST") {
      const input = await readBody(request);
      const envelope = await this.remote.receiveQuery({ ...input, mobileId: binding.mobile.deviceId, bindingId: binding.bindingId, bindingRevision: binding.revision });
      return { state: "desktop_result", envelope };
    }
    if (route === "/v1/notification-ack" && request.method === "POST") {
      const input = await readBody(request, 16384);
      const ack = await this.remote.crypto.open(input.envelope, this.remote.state.identity.encryptionKey, binding.mobile.signKey, "notification-ack");
      const current = this.binding(binding.bindingId);
      const event = this.remote.journal.events.get(ack.eventId);
      if (ack.protocolVersion !== 1 || ack.pcId !== this.remote.pcId || ack.mobileId !== current.mobile.deviceId || ack.bindingId !== current.bindingId
        || ack.bindingRevision !== current.revision || !event || ack.pcSessionEpoch !== event.summary.pcSessionEpoch || ack.eventRevision !== event.summary.eventRevision
        || !["notification_posted", "suppressed_by_user"].includes(ack.status)) throw new Error("invalid_ack");
      this.remote.send({ type: "notification.ack", eventId: ack.eventId, mobileId: ack.mobileId, eventRevision: ack.eventRevision, status: ack.status });
      return { acknowledged: true };
    }
    throw new Error("not_found");
  }
  notify() {
    for (const socket of this.sockets?.clients || []) {
      try { this.authenticate(socket.request); socket.send('{"type":"events.changed"}'); }
      catch { socket.close(4003, "authorization_expired"); }
    }
  }
  async stop() {
    clearInterval(this.timer); this.challenges.clear(); this.sessions.clear();
    this.advertisement?.stop(); this.bonjour?.destroy();
    for (const socket of this.sockets?.clients || []) socket.terminate();
    this.sockets?.close();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
module.exports = { LanService, createTlsIdentity, readBody };
