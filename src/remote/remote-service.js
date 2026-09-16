"use strict";
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { WebSocket } = require("ws");
const { DeviceCredentialStore } = require("./device-credential-store");
const { EventJournal } = require("./event-journal");
const { detail } = require("./event-projector");
const { LanService, createTlsIdentity } = require("./lan-service");
const { validate, safeTree } = require("../../packages/protocol");

class RemoteService extends EventEmitter {
  constructor({ userData, safeStorage, approvals, decisions, allowLocal = false, lanOptions }) {
    super(); this.approvals = approvals; this.decisions = decisions; this.allowLocal = allowLocal; this.lanOptions = lanOptions;
    this.credentials = new DeviceCredentialStore({ filePath: path.join(userData, "mobile-device.enc.json"), safeStorage });
    this.journal = new EventJournal({ filePath: path.join(userData, "mobile-events.enc.json"), safeStorage });
    this.status = "disabled"; this.enabled = false; this.serial = Promise.resolve(); this.generation = 0;
    this.sentRevisions = new Map();
    this.reminderSources = new Map();
    this.onApprovals = () => this.captureApprovals();
    this.onFinalized = event => this.captureFinalized(event);
    approvals.on("changed", this.onApprovals); approvals.on("finalized", this.onFinalized);
    decisions.remoteControlEnabled = () => this.enabled && this.state?.controlEnabled === true;
    decisions.authorizeRemote = (principal, intent) => {
      const binding = this.state?.bindings.find(value => value.bindingId === principal && value.state === "active");
      if (!binding) return null;
      return { pcId: this.pcId, mobileId: binding.mobile.deviceId, bindingId: binding.bindingId, bindingRevision: binding.revision, scopes: binding.scopes, persistentEnabled: binding.persistentEnabled === true };
    };
  }
  get pcId() { return this.state?.identity.deviceId; }
  async initialize() {
    this.crypto = await import("../../packages/protocol/src/crypto.mjs");
    try {
      this.state = this.credentials.load();
      if (this.state) {
        await this.crypto.publicDevice(this.state.identity);
        this.decisions.pcId = this.pcId; this.journal.load();
        if (this.state.enabled) await this.start();
      }
    } catch (error) { this.status = error.message; this.enabled = false; this.storageBlocked = true; }
    return this.snapshot();
  }
  save() { this.credentials.save(this.state); this.emit("changed"); }
  snapshot() {
    return { locale: this.getLocale?.() || "zh-CN", enabled: this.enabled, enrolled: this.state?.enrolled === true, controlEnabled: this.state?.controlEnabled === true, status: this.status,
      relayOrigin: this.state?.relayOrigin || "", pcId: this.pcId || "", lanPort: this.lan?.port || null,
      bindings: (this.state?.bindings || []).map(value => ({ bindingId: value.bindingId, name: value.mobile.name, mobileId: value.mobile.deviceId, state: value.state, revision: value.revision, scopes: value.scopes })),
      pairing: this.pairing ? { pairingId: this.pairing.pairingId, code: this.pairing.code, expiresAt: this.pairing.expiresAt,
        mobileName: this.pairing.mobile?.name || "", fingerprint: this.pairing.fingerprint || "" } : null };
  }
  async configure({ relayOrigin, enrollmentCode, name = "My computer" }) {
    if (this.storageBlocked) throw new Error(this.status);
    if (!this.credentials.available()) throw new Error("secure_storage_unavailable");
    const origin = this.crypto.relayOrigin(relayOrigin, this.allowLocal);
    if (this.state && this.state.relayOrigin !== origin) throw new Error("remove_existing_identity_first");
    if (!this.state) {
      const identity = await this.crypto.generateIdentity("pc", name);
      this.state = { version: 1, identity, tls: await createTlsIdentity(), relayOrigin: origin, bindings: [], enabled: false, controlEnabled: false, enrolled: false };
      this.save(); this.decisions.pcId = this.pcId;
    }
    if (!this.state.enrolled) {
      const code = String(enrollmentCode || "").replace(/[\s-]/g, "").toUpperCase();
      const device = await this.crypto.publicDevice(this.state.identity);
      this.state.registrationId ||= randomUUID(); this.save();
      const proof = await this.crypto.sign({ protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), registrationId: this.state.registrationId, device, codeDigest: await this.crypto.sha256(code) }, this.state.identity.signKey, "enrollment");
      await this.request("/v1/enrollments", { method: "POST", body: { code, device, proof }, auth: false });
      this.state.enrolled = true; this.save();
    }
    await this.start(); return this.snapshot();
  }
  async request(route, { method = "GET", body, auth = true, retry = true } = {}) {
    if (auth) await this.login();
    const result = await fetch(this.state.relayOrigin + route, { method, redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${this.session.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const reader = result.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 262144) { await reader.cancel(); throw new Error("too_large"); }
      chunks.push(Buffer.from(value));
    }
    const value = this.crypto.boundedJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), 262144);
    if (result.status === 401 && auth && retry) { this.session = null; return this.request(route, { method, body, auth, retry: false }); }
    if (!result.ok) {
      if (route === "/v1/auth/challenge" && result.status === 401 && value.error === "unauthorized" && this.state.enrolled) {
        // An authenticated TLS response from our configured authority is learned
        // revocation, unlike a network outage. Persist it before closing LAN.
        for (const binding of this.state.bindings) { binding.state = "revoked"; binding.revision += 1; }
        this.state.controlEnabled = false; this.save(); await this.stop(true); this.status = "device_revoked";
      }
      throw new Error(typeof value.error === "string" ? value.error : "relay_failed");
    }
    return value;
  }
  async login() {
    if (this.session?.expiresAt > Date.now() + 30000) return;
    if (!this.loginFlight) this.loginFlight = (async () => {
      const { challenge } = await this.request("/v1/auth/challenge", { method: "POST", body: { deviceId: this.pcId }, auth: false });
      if (challenge.protocolVersion !== 1 || challenge.relayOrigin !== this.state.relayOrigin || challenge.deviceId !== this.pcId
        || challenge.keyId !== this.state.identity.signKey.kid || challenge.purpose !== "device-session" || challenge.expiresAt <= Date.now()) throw new Error("invalid_challenge");
      this.session = await this.request("/v1/auth/session", { method: "POST", auth: false,
        body: { challengeId: challenge.challengeId, proof: await this.crypto.sign(challenge, this.state.identity.signKey, "device-session") } });
    })().finally(() => { this.loginFlight = null; });
    await this.loginFlight;
  }
  async start() {
    if (this.storageBlocked) throw new Error(this.status);
    if (!this.state?.enrolled || this.enabled) return;
    this.enabled = true; this.state.enabled = true; this.decisions.quiescing = false; this.save();
    this.lan = new LanService(this, this.lanOptions);
    try { await this.lan.start(); } catch { this.status = "lan_unavailable"; }
    this.captureApprovals(); this.connect();
  }
  connect() {
    if (!this.enabled || this.connecting) return;
    const generation = this.generation; this.connecting = true;
    (async () => {
      await this.login(); await this.refreshBindings();
      if (!this.enabled || generation !== this.generation) return;
      const socket = new WebSocket(`${this.state.relayOrigin.replace(/^http/, "ws")}/v1/pcs/${this.pcId}/stream`, {
        headers: { authorization: `Bearer ${this.session.token}` }, maxPayload: 262144, handshakeTimeout: 10000, followRedirects: false,
      });
      this.socket = socket;
      socket.on("open", () => { this.sentRevisions.clear(); this.status = "connected"; this.reconnectAttempt = 0; this.emit("changed"); this.queuePublish(); });
      socket.on("message", data => { this.serial = this.serial.then(() => this.onMessage(this.crypto.boundedJson(data.toString(), 262144))).catch(() => { this.status = "message_rejected"; this.emit("changed"); }); });
      socket.on("error", () => {});
      socket.on("close", () => { if (this.socket === socket) { this.socket = null; this.status = this.enabled ? "offline" : "disabled"; this.emit("changed"); this.reconnect(); } });
      clearTimeout(this.renewTimer); this.renewTimer = setTimeout(() => socket.close(1000, "renew_session"), Math.max(1000, this.session.expiresAt - Date.now() - 15000)); this.renewTimer.unref();
    })().catch(() => { this.status = "offline"; this.emit("changed"); this.reconnect(); }).finally(() => { this.connecting = false; });
  }
  reconnect() {
    clearTimeout(this.reconnectTimer);
    if (!this.enabled) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt || 0, 5)) + Math.random() * 500;
    this.reconnectAttempt = (this.reconnectAttempt || 0) + 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay); this.reconnectTimer.unref();
  }
  send(value) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    const message = JSON.stringify(value);
    if (Buffer.byteLength(message) > 262144 || this.socket.bufferedAmount > 2 * 1024 * 1024) { this.socket.close(1013, "backpressure"); return false; }
    this.socket.send(message); return true;
  }
  async onMessage(value) {
    if (value.type === "sync.request") { await this.refreshBindings(); await this.publishAll(true); }
    if (value.type === "bindings.changed") { await this.refreshBindings(); this.lan?.notify(); }
    if (value.type === "decision.submit") {
      const envelope = await this.receiveDecision(value);
      this.send({ type: "decision.result", decisionId: value.decisionId, mobileId: value.mobileId, envelope });
    }
    if (value.type === "query.submit") {
      const envelope = await this.receiveQuery(value);
      this.send({ type: "query.result", requestId: value.requestId, mobileId: value.mobileId, envelope });
    }
  }
  async refreshBindings() {
    const { bindings } = await this.request("/v1/devices");
    if (!Array.isArray(bindings)) throw new Error("invalid_bindings");
    let changed = false;
    for (const local of this.state.bindings) {
      const cloud = bindings.find(value => value.id === local.bindingId);
      if (local.state === "confirming" && cloud?.state === "active" && cloud.grant_jws === local.grantJws) { local.state = "active"; changed = true; }
      // Relay can reduce authority, never create or expand PC-local trust.
      if ((!cloud || cloud.state !== "active" || cloud.revision !== local.revision) && local.state === "active") { local.state = "revoked"; changed = true; }
      if (local.state === "revoked" && cloud?.state === "active") await this.request(`/v1/bindings/${local.bindingId}`, { method: "DELETE" });
      if (cloud?.state === "revoked" && !cloud.pc_ack) await this.request(`/v1/bindings/${local.bindingId}/ack`, { method: "POST", body: {} });
    }
    if (changed) this.save();
  }
  async beginPairing(scopes = ["events.read", "history.read", "approvals.decide", "questions.answer", "reminders.dismiss"]) {
    if (!this.enabled || !Array.isArray(scopes) || !scopes.includes("events.read") || scopes.some(value => !this.crypto.SCOPES.includes(value))) throw new Error("invalid_scopes");
    if (this.pairing) await this.cancelPairing();
    const offer = { protocolVersion: 1, relayOrigin: this.state.relayOrigin, issuedAt: Date.now(), pairingId: randomUUID(),
      pc: await this.crypto.publicDevice(this.state.identity), lanTlsPin: this.state.tls.pin, scopes };
    const result = await this.request("/v1/pairings", { method: "POST", body: { offer: await this.crypto.sign(offer, this.state.identity.signKey, "pairing-offer") } });
    this.pairing = { ...result, offer }; this.emit("changed"); return this.snapshot();
  }
  async cancelPairing() {
    if (this.pairing) await this.request(`/v1/pairings/${this.pairing.pairingId}/cancel`, { method: "POST", body: {} });
    this.pairing = null; this.emit("changed"); return this.snapshot();
  }
  testNotification() {
    if (!this.enabled) throw new Error("service_unconfigured");
    this.recordReminder({ agentId: "vibe-halo", title: "手机伴侣测试提醒", content: "这是一条测试事件，不包含审批操作。" }, "completion");
    return this.snapshot();
  }
  async pollPairing() {
    if (!this.pairing) return this.snapshot();
    const result = await this.request(`/v1/pairings/${this.pairing.pairingId}/status`);
    if (["expired", "cancelled"].includes(result.state)) { this.pairing = null; this.emit("changed"); return this.snapshot(); }
    if (result.claim) {
      const mobile = await this.crypto.publicDevice(result.claim.mobile);
      const proof = await this.crypto.verify(result.claim.proof, mobile.signKey, "pairing-claim");
      if (this.crypto.canonical(proof.mobile) !== this.crypto.canonical(mobile) || proof.relayOrigin !== this.state.relayOrigin || proof.codeDigest !== await this.crypto.sha256(this.pairing.code)) throw new Error("invalid_claim");
      const { protocolVersion, relayOrigin, pairingId, pc, lanTlsPin, scopes } = this.pairing.offer;
      this.pairing.transcript = { protocolVersion, relayOrigin, pairingId, pc, mobile, lanTlsPin, scopes };
      this.pairing.mobile = mobile; this.pairing.fingerprint = await this.crypto.pairingFingerprint(this.pairing.transcript);
    }
    this.emit("changed"); return this.snapshot();
  }
  async confirmPairing(fingerprint) {
    const pairing = this.pairing;
    if (!pairing?.mobile || fingerprint !== pairing.fingerprint || pairing.expiresAt <= Date.now()) throw new Error("pairing_expired");
    const previous = this.state.bindings.find(value => value.pairingId === pairing.pairingId && value.state === "confirming");
    const grant = previous || { ...pairing.transcript, spaceId: `space_${this.pcId}`, bindingId: randomUUID(), revision: 1, issuedAt: Date.now() };
    const grantJws = previous?.grantJws || await this.crypto.sign(grant, this.state.identity.signKey, "binding-grant");
    // Persist explicit local trust before the relay is allowed to activate it.
    this.state.bindings = this.state.bindings.filter(value => value.mobile.deviceId !== grant.mobile.deviceId);
    this.state.bindings.push({ ...grant, grantJws, state: "confirming", persistentEnabled: grant.scopes.includes("approvals.persistent") });
    while (this.state.bindings.length > 32) {
      const index = this.state.bindings.findIndex(value => value.state === "revoked");
      if (index < 0) throw new Error("capacity_exceeded");
      this.state.bindings.splice(index, 1);
    }
    this.save();
    await this.request(`/v1/pairings/${pairing.pairingId}/confirm`, { method: "POST", body: { grant: grantJws } });
    const binding = this.state.bindings.find(value => value.bindingId === grant.bindingId);
    binding.state = "active"; this.pairing = null; this.save(); await this.publishAll(); return this.snapshot();
  }
  async revoke(bindingId) {
    const binding = this.state?.bindings.find(value => value.bindingId === bindingId);
    if (!binding) throw new Error("not_found");
    binding.state = "revoked"; binding.revision += 1; this.save(); this.lan?.notify();
    try { await this.request(`/v1/bindings/${bindingId}`, { method: "DELETE" }); } catch { this.status = "revocation_pending_cloud"; }
    return this.snapshot();
  }
  setControl(enabled) {
    if (!this.state || typeof enabled !== "boolean") throw new Error("invalid_setting");
    this.state.controlEnabled = enabled; this.save(); this.sentRevisions.clear(); this.queuePublish(); return this.snapshot();
  }
  captureApprovals() {
    if (!this.enabled || !this.pcId) return;
    const context = { pcId: this.pcId, pcSessionEpoch: this.approvals.pcSessionEpoch, currentId: this.approvals.current?.id, pendingCount: this.approvals.size, now: Date.now(), persistentEnabled: true };
    for (const entry of this.approvals.listPending({ limit: 500 }).entries) { const value = detail(entry, context); if (value) this.journal.put(value); }
    this.queuePublish();
  }
  captureFinalized(event) {
    if (!this.enabled || !this.pcId) return;
    const value = detail({ ...event.entry, state: event.state, remoteContextComplete: false }, { pcId: this.pcId, pcSessionEpoch: this.approvals.pcSessionEpoch, currentId: null, pendingCount: this.approvals.size, now: Date.now() });
    if (value) this.journal.put(value); this.queuePublish();
  }
  recordReminder(input, kind = "input") {
    if (!this.enabled || !this.pcId) return;
    const sourceKey = input.requestKey;
    if (sourceKey && this.reminderSources.has(sourceKey)) return this.reminderSources.get(sourceKey).eventId;
    const createdAt = Date.now(), eventId = `evt_${randomUUID()}`;
    const summary = { protocolVersion: 1, eventId, pcId: this.pcId, pcSessionEpoch: this.approvals.pcSessionEpoch, streamSeq: 1, eventRevision: 1,
      kind, agentId: input.agentId || "codex", createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + (kind === "input" ? 120000 : 3600000)).toISOString(),
      state: kind === "input" ? "pending" : "resolved", actionable: false, pendingCount: this.approvals.size,
      summaryKey: kind === "input" ? "remote.inputRequested" : kind === "plan" ? "remote.planReady" : "remote.completed" };
    const { sanitizeValue, truncateUtf8 } = require("../history-store");
    const rawContent = typeof input.output === "string" ? input.output : typeof input.content === "string" ? input.content : input.questions ? JSON.stringify(sanitizeValue(input.questions, "questions"), null, 2) : "";
    const content = truncateUtf8(sanitizeValue(rawContent, "content"), 48000);
    const value = { protocolVersion: 1, summary, approvalId: eventId, approvalContextDigest: `sha256:${"0".repeat(64)}`, toolName: "", toolInputText: content,
      description: truncateUtf8(typeof input.title === "string" ? input.title : "", 900), options: [], questions: [], truncated: content !== rawContent, redacted: false, remoteActionable: false, pcTime: new Date(createdAt).toISOString() };
    if (sourceKey) {
      this.reminderSources.set(sourceKey, { eventId, sessionId: input.sessionId, agentId: input.agentId || "codex" });
      if (this.reminderSources.size > 500) this.reminderSources.delete(this.reminderSources.keys().next().value);
    }
    this.journal.put(value); this.queuePublish(); return eventId;
  }
  resolveReminder(requestKey) {
    const source = this.reminderSources.get(requestKey); if (!source) return;
    this.reminderSources.delete(requestKey);
    const previous = this.journal.events.get(source.eventId);
    if (!previous || previous.summary.state !== "pending") return;
    const value = structuredClone(previous); value.summary.state = "resolved"; value.summary.actionable = false; value.summary.eventRevision += 1;
    this.journal.put(value); this.queuePublish();
  }
  resolveSessionReminders(agentId, sessionId) {
    for (const [key, value] of this.reminderSources) if (value.agentId === agentId && value.sessionId === sessionId) this.resolveReminder(key);
  }
  queuePublish() {
    clearTimeout(this.publishTimer); this.publishTimer = setTimeout(() => { this.serial = this.serial.then(() => this.publishAll()).catch(() => {}); }, 40); this.publishTimer.unref(); this.lan?.notify();
  }
  async encryptEvent(value, binding) {
    value = structuredClone(value);
    if (!this.state.controlEnabled || !binding.scopes.includes(value.summary.kind === "question" ? "questions.answer" : "approvals.decide")) value.remoteActionable = false;
    if (binding.persistentEnabled !== true || !binding.scopes.includes("approvals.persistent")) {
      value.options = value.options.filter(option => !require("./event-projector").persistent(option.id)); value.persistentPreviews = {};
    }
    return this.crypto.seal({ protocolVersion: 1, type: "event.detail", relayOrigin: this.state.relayOrigin, pcId: this.pcId, mobileId: binding.mobile.deviceId,
      bindingId: binding.bindingId, bindingRevision: binding.revision, detail: { ...value, pcTime: new Date().toISOString() } }, this.state.identity.signKey, binding.mobile.encryptionKey);
  }
  async eventsFor(binding, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 500) throw new Error("invalid_cursor");
    const values = this.journal.list();
    const events = []; let bytes = 256, consumed = 0;
    for (const value of values.slice(offset, offset + 50)) {
      const event = { summary: value.summary, envelope: await this.encryptEvent(value, binding) };
      const size = Buffer.byteLength(JSON.stringify(event)); if (bytes + size > 262144) break;
      events.push(event); bytes += size; consumed += 1;
    }
    return { events, nextOffset: offset + consumed < values.length ? offset + consumed : null, desktopOnline: true, snapshotVersion: `${this.journal.sequence}:${values.length}` };
  }
  async publishAll(force = false) {
    if (!this.enabled || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const value of this.journal.list()) for (const binding of this.state.bindings.filter(value => value.state === "active" && value.scopes.includes("events.read"))) {
      const key = `${binding.bindingId}:${value.summary.eventId}`, revision = `${binding.revision}:${value.summary.eventRevision}`;
      if ((!force || value.summary.state !== "pending") && this.sentRevisions.get(key) === revision) continue;
      if (!this.send({ type: "event.upsert", summary: value.summary, recipients: [{ mobileId: binding.mobile.deviceId, envelope: await this.encryptEvent(value, binding) }] })) return;
      this.sentRevisions.set(key, revision);
      if (this.sentRevisions.size > 3200) this.sentRevisions.delete(this.sentRevisions.keys().next().value);
    }
  }
  async receiveDecision(message) {
    const binding = this.state?.bindings.find(value => value.bindingId === message.bindingId && value.state === "active");
    if (!this.enabled || !binding || binding.mobile.deviceId !== message.mobileId || binding.revision !== message.bindingRevision) throw new Error("forbidden");
    const intent = await this.crypto.open(message.envelope, this.state.identity.encryptionKey, binding.mobile.signKey, "decision-intent");
    if (!validate("decisionIntent", intent).ok || intent.decisionId !== message.decisionId || intent.mobileId !== message.mobileId || intent.bindingId !== binding.bindingId) throw new Error("invalid_intent");
    const result = this.decisions.decideVerifiedRemote(intent, binding.bindingId);
    return this.crypto.seal({ protocolVersion: 1, type: "decision.receipt", relayOrigin: this.state.relayOrigin, pcId: this.pcId, mobileId: binding.mobile.deviceId,
      bindingId: binding.bindingId, bindingRevision: binding.revision, decisionId: intent.decisionId, pcSessionEpoch: this.approvals.pcSessionEpoch,
      issuedAt: new Date().toISOString(), ...result }, this.state.identity.signKey, binding.mobile.encryptionKey, "decision-receipt");
  }
  async receiveQuery(message) {
    const binding = this.state?.bindings.find(value => value.bindingId === message.bindingId && value.state === "active");
    if (!this.enabled || !binding || binding.mobile.deviceId !== message.mobileId || binding.revision !== message.bindingRevision) throw new Error("forbidden");
    const query = await this.crypto.open(message.envelope, this.state.identity.encryptionKey, binding.mobile.signKey, "read-request");
    if (query.protocolVersion !== 1 || query.requestId !== message.requestId || query.pcId !== this.pcId || query.mobileId !== binding.mobile.deviceId
      || query.bindingId !== binding.bindingId || query.bindingRevision !== binding.revision || query.relayOrigin !== this.state.relayOrigin
      || !Number.isSafeInteger(query.issuedAt) || (query.type !== "clock.read" && Math.abs(Date.now() - query.issuedAt) > 30000)
      || !["clock.read", "history.list", "history.detail", "reminder.dismiss"].includes(query.type)) throw new Error("invalid_query");
    if (binding.state !== "active") throw new Error("forbidden");
    if (!binding.scopes.includes(query.type === "clock.read" ? "events.read" : query.type === "reminder.dismiss" ? "reminders.dismiss" : "history.read")) throw new Error("forbidden");
    const output = { protocolVersion: 1, type: query.type === "clock.read" ? "clock.response" : "history.response", requestId: query.requestId, relayOrigin: this.state.relayOrigin,
      pcId: this.pcId, mobileId: binding.mobile.deviceId, bindingId: binding.bindingId, bindingRevision: binding.revision, records: [], nextOffset: null };
    if (query.type === "clock.read") {
      // The fresh request ID is the challenge; phone wall-clock skew must not
      // prevent calibration. No history or decision capability is exposed.
      output.pcTime = Date.now(); output.pcSessionEpoch = this.approvals.pcSessionEpoch;
    } else if (query.type === "reminder.dismiss") {
      const event = this.journal.events.get(query.eventId);
      if (!this.state.controlEnabled || this.decisions.quiescing || !event || event.summary.kind !== "input" || event.summary.pcSessionEpoch !== query.pcSessionEpoch
        || event.summary.eventRevision !== query.eventRevision || event.summary.pcSessionEpoch !== this.approvals.pcSessionEpoch) throw new Error("forbidden");
      const source = [...this.reminderSources].find(([, value]) => value.eventId === query.eventId);
      if (source) {
        const item = this.inputRequests?.byRequestKey.get(source[0]);
        if (item) this.inputRequests.dismiss(item.id);
        this.resolveReminder(source[0]);
      }
    } else if (query.type === "history.list") {
      const offset = query.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > 200) throw new Error("invalid_cursor");
      const records = this.historyStore?.list() || [];
      for (const item of records.slice(offset, offset + 25)) {
        const record = { id: item.id, kind: item.kind, agentId: item.agentId, title: item.title, toolName: item.toolName, outcome: item.outcome, createdAt: item.createdAt, resolvedAt: item.resolvedAt };
        output.records.push(record);
        if (Buffer.byteLength(JSON.stringify(output)) > 60000) { output.records.pop(); break; }
      }
      if (offset + output.records.length < records.length) output.nextOffset = offset + output.records.length;
    } else {
      if (typeof query.historyId !== "string" || query.historyId.length > 240) throw new Error("invalid_id");
      const record = this.historyStore?.get(query.historyId);
      if (record) {
        const text = JSON.stringify(record, null, 2);
        output.records.push({ id: record.id, text: require("../history-store").truncateUtf8(text, 48000), truncated: Buffer.byteLength(text) > 48000 });
      }
    }
    return this.crypto.seal(output, this.state.identity.signKey, binding.mobile.encryptionKey, "read-response");
  }
  async stop(disable = false) {
    this.enabled = false; this.generation += 1;
    for (const timer of [this.publishTimer, this.reconnectTimer, this.renewTimer]) clearTimeout(timer);
    if (this.socket?.readyState === WebSocket.OPEN) {
      const socket = this.socket;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 200);
        socket.send('{"type":"companion.pause"}', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.socket?.terminate(); this.socket = null; await this.lan?.stop(); this.lan = null;
    if (disable && this.state) { this.state.enabled = false; this.state.controlEnabled = false; this.save(); }
    if (this.state && !this.journal.damaged) this.journal.flush();
    this.status = "disabled"; this.emit("changed");
  }
}
module.exports = { RemoteService };
