import { DurableObject } from "cloudflare:workers";
import { Fault, response, sessionByHash, authorize, record, id, text, now, sha256, type Session } from "./common";
import { validate, safeTree } from "../../../packages/protocol/src/index.js";
import { deliverPush } from "./push";

type SocketIdentity = { pcId: string; tokenHash: string; deviceId: string; kind: "pc" | "mobile"; expiresAt: number };

export class Relay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,revision INTEGER NOT NULL,summary TEXT NOT NULL,recipients TEXT NOT NULL,expires_at INTEGER NOT NULL,bytes INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS receipts(decision_id TEXT PRIMARY KEY,mobile_id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT,expires_at INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS push_jobs(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,mobile_id TEXT NOT NULL,revision INTEGER NOT NULL,due_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending')");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS queries(request_id TEXT PRIMARY KEY,mobile_id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT,expires_at INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notification_acks(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY,window_end INTEGER NOT NULL,attempts INTEGER NOT NULL)");
    });
  }

  async fetch(request: Request): Promise<Response> {
    const identity: SocketIdentity = JSON.parse(request.headers.get("x-vibe-identity") || "null");
    if (!identity) return response({ error: "unauthorized" }, 401);
    await authorize(await sessionByHash(identity.tokenHash, this.env), identity.pcId, this.env);
    const existing = this.ctx.getWebSockets(identity.deviceId);
    for (const socket of existing.slice(0, Math.max(0, existing.length - 1))) socket.close(4000, "connection_replaced");
    if (this.ctx.getWebSockets().length >= 24) return response({ error: "capacity_exceeded" }, 429);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [identity.kind, identity.deviceId]);
    server.serializeAttachment(identity);
    server.send(JSON.stringify({ type: "hello", protocolVersion: 1, pcId: identity.pcId, expiresAt: identity.expiresAt }));
    if (identity.kind === "mobile") await this.sendPc({ type: "sync.request", mobileId: identity.deviceId });
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async live(socket: WebSocket): Promise<boolean> {
    try {
      const identity = socket.deserializeAttachment() as SocketIdentity;
      await authorize(await sessionByHash(identity.tokenHash, this.env), identity.pcId, this.env);
      return true;
    } catch { socket.close(4003, "authorization_expired"); return false; }
  }
  private async sendPc(value: object): Promise<boolean> {
    let sent = false;
    for (const socket of this.ctx.getWebSockets("pc")) {
      if (!await this.live(socket)) continue;
      try { socket.send(JSON.stringify(value)); sent = true; } catch { socket.close(); }
    }
    return sent;
  }
  private async notify(value: object, mobileId?: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets(mobileId || "mobile")) {
      if (!await this.live(socket)) continue;
      try { socket.send(JSON.stringify(value)); } catch { socket.close(); }
    }
  }
  async invalidate(bindingId: string): Promise<void> {
    await this.sendPc({ type: "bindings.changed", bindingId });
    await this.notify({ type: "bindings.changed", bindingId });
  }
  private async rpc(work: () => Promise<object>): Promise<object> {
    try { return await work(); }
    catch (error) { return { relayError: error instanceof Fault ? error.code : "request_failed", relayStatus: error instanceof Fault ? error.status : 500 }; }
  }
  private budget(deviceId: string, operation: string, limit: number): void {
    const key = `${deviceId}:${operation}`;
    this.ctx.storage.sql.exec("DELETE FROM budgets WHERE window_end<?", now() - 60000);
    const row = this.ctx.storage.sql.exec<{ attempts: number }>("INSERT INTO budgets(id,window_end,attempts) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN window_end<? THEN 1 ELSE attempts+1 END,window_end=CASE WHEN window_end<? THEN ? ELSE window_end END RETURNING attempts", key, now() + 60000, now(), now(), now() + 60000).one();
    if (row.attempts > limit) throw new Fault("rate_limited", 429);
  }
  async list(pcId: string, tokenHash: string, offset = 0): Promise<object> { return this.rpc(() => this.listInternal(pcId, tokenHash, offset)); }
  async submit(pcId: string, tokenHash: string, decisionId: string, envelope: string): Promise<object> { return this.rpc(() => this.submitInternal(pcId, tokenHash, decisionId, envelope)); }
  async receipt(pcId: string, tokenHash: string, decisionId: string): Promise<object> { return this.rpc(() => this.receiptInternal(pcId, tokenHash, decisionId)); }
  async query(pcId: string, tokenHash: string, requestId: string, envelope?: string): Promise<object> { return this.rpc(() => this.queryInternal(pcId, tokenHash, requestId, envelope)); }
  private async listInternal(pcId: string, tokenHash: string, offset = 0): Promise<object> {
    const session = await sessionByHash(tokenHash, this.env);
    this.budget(session.device.deviceId, "events", 120);
    await authorize(session, pcId, this.env);
    const rows = this.ctx.storage.sql.exec<{ summary: string; recipients: string }>("SELECT summary,recipients FROM events WHERE expires_at>? ORDER BY rowid DESC LIMIT 50 OFFSET ?", now(), offset).toArray();
    const events = []; let consumed = 0; let bytes = 256;
    for (const row of rows) {
      const recipients = JSON.parse(row.recipients) as { mobileId: string; envelope: string }[];
      const recipient = recipients.find(value => value.mobileId === session.device.deviceId);
      if (recipient) {
        const event = { summary: JSON.parse(row.summary), envelope: recipient.envelope };
        const size = new TextEncoder().encode(JSON.stringify(event)).length;
        if (bytes + size > 262144) break;
        bytes += size; events.push(event);
      }
      consumed += 1;
    }
    let desktopOnline = false;
    for (const socket of this.ctx.getWebSockets("pc")) if (await this.live(socket)) desktopOnline = true;
    const version = this.ctx.storage.sql.exec<{ sequence: number; count: number }>("SELECT COALESCE(MAX(json_extract(summary,'$.streamSeq')),0) AS sequence,COUNT(*) AS count FROM events WHERE expires_at>?", now()).one();
    return { events, nextOffset: consumed < rows.length || rows.length === 50 ? offset + consumed : null, desktopOnline, snapshotVersion: `${version.sequence}:${version.count}` };
  }
  private async submitInternal(pcId: string, tokenHash: string, decisionId: string, envelope: string): Promise<object> {
    const session = await sessionByHash(tokenHash, this.env);
    this.budget(session.device.deviceId, "decisions", 20);
    const binding = await authorize(session, pcId, this.env);
    if (!binding || !["approvals.decide", "questions.answer"].some(scope => JSON.parse(binding.scopes_json).includes(scope))) throw new Fault("forbidden", 403);
    id(decisionId); text(envelope, 262144);
    const digest = await sha256(envelope);
    this.ctx.storage.sql.exec("DELETE FROM receipts WHERE expires_at<?", now());
    const previous = this.ctx.storage.sql.exec<{ mobile_id: string; digest: string; envelope: string | null }>("SELECT mobile_id,digest,envelope FROM receipts WHERE decision_id=?", decisionId).toArray()[0];
    if (previous) {
      if (previous.mobile_id !== session.device.deviceId || previous.digest !== digest) throw new Fault("decision_conflict", 409);
      if (previous.envelope) return { state: "desktop_result", envelope: previous.envelope };
    } else {
      const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM receipts").one().n;
      if (count >= 500) throw new Fault("capacity_exceeded", 429);
      this.ctx.storage.sql.exec("INSERT INTO receipts(decision_id,mobile_id,digest,expires_at) VALUES(?,?,?,?)", decisionId, session.device.deviceId, digest, now() + 600000);
    }
    await this.schedule();
    if (!await this.sendPc({ type: "decision.submit", decisionId, mobileId: session.device.deviceId, bindingId: binding.id, bindingRevision: binding.revision, envelope })) return { state: "desktop_offline" };
    return { state: "relay_received" };
  }
  private async receiptInternal(pcId: string, tokenHash: string, decisionId: string): Promise<object> {
    const session = await sessionByHash(tokenHash, this.env); await authorize(session, pcId, this.env);
    this.budget(session.device.deviceId, "receipts", 120);
    const row = this.ctx.storage.sql.exec<{ envelope: string | null }>("SELECT envelope FROM receipts WHERE decision_id=? AND mobile_id=? AND expires_at>?", decisionId, session.device.deviceId, now()).toArray()[0];
    return row?.envelope ? { state: "desktop_result", envelope: row.envelope } : { state: "result_unknown" };
  }
  private async queryInternal(pcId: string, tokenHash: string, requestId: string, envelope?: string): Promise<object> {
    const session = await sessionByHash(tokenHash, this.env);
    this.budget(session.device.deviceId, "queries", 120);
    const binding = await authorize(session, pcId, this.env);
    if (!binding || !["history.read", "reminders.dismiss"].some(scope => JSON.parse(binding.scopes_json).includes(scope))) throw new Fault("forbidden", 403);
    id(requestId);
    this.ctx.storage.sql.exec("DELETE FROM queries WHERE expires_at<=?", now());
    const previous = this.ctx.storage.sql.exec<{ mobile_id: string; digest: string; envelope: string | null }>("SELECT mobile_id,digest,envelope FROM queries WHERE request_id=?", requestId).toArray()[0];
    if (previous && previous.mobile_id !== session.device.deviceId) throw new Fault("forbidden", 403);
    if (!envelope) return previous?.envelope ? { state: "desktop_result", envelope: previous.envelope } : { state: "waiting" };
    text(envelope, 262144); const digest = await sha256(envelope);
    if (previous && previous.digest !== digest) throw new Fault("request_conflict", 409);
    if (previous?.envelope) return { state: "desktop_result", envelope: previous.envelope };
    if (!previous) {
      const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queries").one().n;
      if (count >= 64) throw new Fault("capacity_exceeded", 429);
      this.ctx.storage.sql.exec("INSERT INTO queries(request_id,mobile_id,digest,expires_at) VALUES(?,?,?,?)", requestId, session.device.deviceId, digest, now() + 60000);
    }
    const online = await this.sendPc({ type: "query.submit", requestId, mobileId: session.device.deviceId, bindingId: binding.id, bindingRevision: binding.revision, envelope });
    await this.schedule(); return { state: online ? "relay_received" : "desktop_offline" };
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof message !== "string" || new TextEncoder().encode(message).length > 262144) throw new Fault("too_large", 413);
      const identity = socket.deserializeAttachment() as SocketIdentity;
      const session = await sessionByHash(identity.tokenHash, this.env);
      this.budget(session.device.deviceId, "stream", session.device.kind === "pc" ? 4000 : 30);
      await authorize(session, identity.pcId, this.env);
      const value = record(JSON.parse(message));
      if (!safeTree(value)) throw new Fault("invalid_message");
      if (value.type === "ping") { socket.send('{"type":"pong"}'); return; }
      if (session.device.kind !== "pc") throw new Fault("forbidden", 403);
      if (value.type === "companion.pause") {
        this.ctx.storage.sql.exec("UPDATE push_jobs SET state='cancelled' WHERE state='pending'");
        socket.send('{"type":"companion.paused"}');
        return;
      }
      if (value.type === "event.upsert") { await this.upsert(identity.pcId, session, value); return; }
      if (value.type === "decision.result") {
        const decisionId = id(value.decisionId), mobileId = id(value.mobileId), envelope = text(value.envelope, 262144);
        this.ctx.storage.sql.exec("UPDATE receipts SET envelope=? WHERE decision_id=? AND mobile_id=?", envelope, decisionId, mobileId);
        await this.notify({ type: "decision.result", decisionId }, mobileId);
        return;
      }
      if (value.type === "query.result") {
        const requestId = id(value.requestId), mobileId = id(value.mobileId), envelope = text(value.envelope, 262144);
        this.ctx.storage.sql.exec("UPDATE queries SET envelope=? WHERE request_id=? AND mobile_id=? AND expires_at>?", envelope, requestId, mobileId, now());
        await this.notify({ type: "query.result", requestId }, mobileId); return;
      }
      if (value.type === "notification.ack") {
        const eventId = id(value.eventId), mobileId = id(value.mobileId), revision = Number(value.eventRevision);
        if (!Number.isSafeInteger(revision) || revision < 1 || !["notification_posted", "suppressed_by_user"].includes(String(value.status))) throw new Fault("invalid_ack");
        const key = `${eventId}:${mobileId}:${revision}`;
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO notification_acks(id,expires_at) VALUES(?,?)", key, now() + 3600000);
        this.ctx.storage.sql.exec("UPDATE push_jobs SET state='acknowledged' WHERE id=? AND state='pending'", key);
        return;
      }
      throw new Fault("invalid_message");
    } catch (error) {
      const code = error instanceof Fault ? error.code : "invalid_message";
      try { socket.send(JSON.stringify({ type: "error", error: code })); } catch { /* closed */ }
      if (["unauthorized", "device_revoked", "forbidden"].includes(code)) socket.close(4003, code);
    }
  }
  private async upsert(pcId: string, session: Session, value: Record<string, unknown>): Promise<void> {
    const summary = record(value.summary);
    if (summary.pcId !== pcId || !validate("eventSummary", summary).ok) throw new Fault("invalid_event");
    const revision = Number(summary.eventRevision);
    const eventId = id(summary.eventId), epoch = id(summary.pcSessionEpoch);
    if (!Array.isArray(value.recipients) || value.recipients.length > Number(this.env.MAX_BINDINGS_PER_PC)) throw new Fault("invalid_recipients");
    const recipients: { mobileId: string; envelope: string }[] = [];
    for (const raw of value.recipients) {
      const recipient = record(raw, ["mobileId", "envelope"]);
      const mobileId = id(recipient.mobileId), envelope = text(recipient.envelope, 262144);
      const binding = await this.env.DB.prepare("SELECT scopes_json FROM bindings WHERE pc_id=? AND mobile_id=? AND state='active'").bind(pcId, mobileId).first<{ scopes_json: string }>();
      if (binding && JSON.parse(binding.scopes_json).includes("events.read") && !recipients.some(value => value.mobileId === mobileId)) recipients.push({ mobileId, envelope });
    }
    await authorize(session, pcId, this.env);
    const old = this.ctx.storage.sql.exec<{ revision: number; epoch: string; summary: string; recipients: string }>("SELECT revision,epoch,summary,recipients FROM events WHERE event_id=?", eventId).toArray()[0];
    if (old && (old.epoch !== epoch || old.revision > revision)) return;
    if (old && JSON.parse(old.summary).state !== "pending" && summary.state === "pending") return;
    if (old?.revision === revision) {
      if (old.summary !== JSON.stringify(summary)) throw new Fault("revision_conflict", 409);
      for (const recipient of JSON.parse(old.recipients)) if (!recipients.some(value => value.mobileId === recipient.mobileId)) recipients.push(recipient);
    }
    const summaryText = JSON.stringify(summary), recipientText = JSON.stringify(recipients);
    const bytes = new TextEncoder().encode(summaryText + recipientText).length;
    this.ctx.storage.sql.exec("INSERT INTO events(event_id,epoch,revision,summary,recipients,expires_at,bytes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET revision=excluded.revision,summary=excluded.summary,recipients=excluded.recipients,expires_at=excluded.expires_at,bytes=excluded.bytes",
      eventId, epoch, revision, summaryText, recipientText, now() + 86400000, bytes);
    this.ctx.storage.sql.exec("UPDATE push_jobs SET state='cancelled' WHERE event_id=? AND revision<? AND state='pending'", eventId, revision);
    if (summary.state === "pending" && (summary.actionable === true || summary.kind === "input") || summary.kind === "completion" || summary.kind === "plan") {
      const expiry = Math.min(Date.parse(String(summary.expiresAt)), now() + 3600000);
      for (const recipient of recipients) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO push_jobs(id,event_id,mobile_id,revision,due_at,expires_at) VALUES(?,?,?,?,?,?)",
        `${eventId}:${recipient.mobileId}:${revision}`, eventId, recipient.mobileId, revision, now() + 1500, expiry);
      this.ctx.storage.sql.exec("UPDATE push_jobs SET state='acknowledged' WHERE state='pending' AND id IN (SELECT id FROM notification_acks WHERE expires_at>?)", now());
    } else this.ctx.storage.sql.exec("UPDATE push_jobs SET state='cancelled' WHERE event_id=? AND state='pending'", eventId);
    this.prune();
    await this.schedule();
    await this.notify({ type: "events.changed" });
  }
  private prune(): void {
    this.ctx.storage.sql.exec("DELETE FROM receipts WHERE expires_at<?", now());
    this.ctx.storage.sql.exec("DELETE FROM queries WHERE expires_at<?", now());
    this.ctx.storage.sql.exec("DELETE FROM notification_acks WHERE expires_at<?", now());
    this.ctx.storage.sql.exec("DELETE FROM notification_acks WHERE id IN (SELECT id FROM notification_acks ORDER BY rowid DESC LIMIT -1 OFFSET 3000)");
    this.ctx.storage.sql.exec("DELETE FROM push_jobs WHERE expires_at<? OR event_id NOT IN (SELECT event_id FROM events)", now());
    this.ctx.storage.sql.exec("DELETE FROM events WHERE expires_at<?", now());
    this.ctx.storage.sql.exec("DELETE FROM events WHERE event_id IN (SELECT event_id FROM events ORDER BY rowid DESC LIMIT -1 OFFSET 500)");
    while ((this.ctx.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes),0) AS n FROM events").one().n) > 10 * 1024 * 1024) {
      this.ctx.storage.sql.exec("DELETE FROM events WHERE rowid=(SELECT MIN(rowid) FROM events)");
    }
  }
  private async schedule(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ t: number | null }>("SELECT MIN(due_at) AS t FROM push_jobs WHERE state='pending'").one().t;
    await this.ctx.storage.setAlarm(Math.max(now() + 100, Math.min(next ?? now() + 600000, now() + 600000)));
  }
  async alarm(): Promise<void> {
    this.prune();
    for (const socket of this.ctx.getWebSockets()) await this.live(socket);
    const jobs = this.ctx.storage.sql.exec<{ id: string; mobile_id: string; attempts: number; summary: string }>("SELECT j.id,j.mobile_id,j.attempts,e.summary FROM push_jobs j JOIN events e ON e.event_id=j.event_id WHERE j.state='pending' AND j.due_at<=? AND j.expires_at>? AND j.revision=e.revision LIMIT 20", now(), now()).toArray();
    for (const job of jobs) {
      const summary = JSON.parse(job.summary);
      let retryDelay = 0;
      const result = await deliverPush(this.env, summary.pcId, job.mobile_id, summary, () => {
        const current = this.ctx.storage.sql.exec<{ revision: number; state: string }>("SELECT e.revision,j.state FROM events e JOIN push_jobs j ON j.event_id=e.event_id WHERE j.id=?", job.id).toArray()[0];
        return current?.revision === summary.eventRevision && current.state === "pending";
      }, delay => { retryDelay = delay; });
      const attempts = job.attempts + 1;
      const state = result === "retry" && attempts < 5 ? "pending" : result === "retry" ? "failed" : result;
      const delay = Math.max(retryDelay, [1000, 5000, 30000, 60000, 300000][attempts - 1]) + Math.floor(Math.random() * 500);
      this.ctx.storage.sql.exec("UPDATE push_jobs SET state=?,attempts=?,due_at=? WHERE id=? AND state='pending'", state, attempts, now() + delay, job.id);
    }
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
    if (count || this.ctx.getWebSockets().length) await this.schedule();
  }
  webSocketClose(socket: WebSocket): void { socket.close(); }
  webSocketError(socket: WebSocket): void { socket.close(); }
}
