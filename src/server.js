"use strict";

const crypto = require("crypto");
const http = require("http");
const {
  BODY_LIMIT,
  RUNTIME_PATH,
  SERVER_HEADER,
  SERVER_ID,
  TOKEN_HEADER,
} = require("./constants");
const { clearRuntime, writeRuntime } = require("./runtime-config");
const {
  agent,
  encodeDecision,
  noDecisionOutput,
  normalizeRequest,
} = require("./agent-registry");

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body = "", contentType = "application/json") {
  if (res.writableEnded || res.destroyed) return;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    [SERVER_HEADER]: SERVER_ID,
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return resolve({ ok: false, reason: "too-large", value: null });
      try { resolve({ ok: true, reason: null, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
      catch { resolve({ ok: false, reason: "invalid-json", value: null }); }
    });
    req.on("error", () => resolve({ ok: false, reason: "read-error", value: null }));
  });
}

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function text(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function normalizePermission(data) {
  return normalizeRequest("codex", data);
}

function sendAdapterDecision(res, status, agentId, body) {
  const output = typeof body === "string" ? body : noDecisionOutput(agentId);
  return send(res, output ? status : 204, output);
}

class IslandServer {
  constructor(options) {
    if (!options?.approvalStore) throw new TypeError("approvalStore is required");
    this.approvalStore = options.approvalStore;
    this.onEvent = options.onEvent || (() => {});
    this.isApprovalEnabled = options.isApprovalEnabled || (() => true);
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.runtimePath = options.runtimePath || RUNTIME_PATH;
    this.ownerPid = options.ownerPid || process.pid;
    this.server = null;
    this.port = null;
    this.token = null;
  }

  async start() {
    if (this.server) return this.status();
    this.token = crypto.randomBytes(32).toString("hex");
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("clientError", (_err, socket) => {
      try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch {}
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    writeRuntime({
      app: SERVER_ID,
      port: this.port,
      ownerPid: this.ownerPid,
      token: this.token,
      startedAt: new Date().toISOString(),
    }, { filePath: this.runtimePath });
    this.logger.info("Local server started", { port: this.port });
    return this.status();
  }

  status() {
    return { listening: !!this.server?.listening, port: this.port, runtimePath: this.runtimePath };
  }

  authenticated(req) {
    return safeEqual(req.headers[TOKEN_HEADER], this.token);
  }

  async handle(req, res) {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, app: SERVER_ID, port: this.port });
    }
    if (req.method !== "POST" || (req.url !== "/permission" && req.url !== "/event")) {
      return send(res, 404, { error: "not-found" });
    }
    if (!this.authenticated(req)) {
      this.logger.warn("Rejected unauthenticated local request", { route: req.url });
      return send(res, 401, { error: "unauthorized" });
    }
    const parsed = await readBody(req);
    if (!parsed.ok) {
      this.logger.warn("Rejected request body", { route: req.url, reason: parsed.reason });
      if (req.url === "/permission") return send(res, parsed.reason === "too-large" ? 413 : 400, "{}");
      return send(res, parsed.reason === "too-large" ? 413 : 400, { error: parsed.reason });
    }
    const data = parsed.value;
    const agentId = text(data?.agent_id || data?.agentId, 80).toLowerCase();
    const adapter = agent(agentId);
    if (!data || !adapter) return send(res, 400, req.url === "/permission" ? "{}" : { error: "invalid-agent" });
    const normalized = normalizeRequest(agentId, data);
    if (!normalized) return sendAdapterDecision(res, 400, agentId, noDecisionOutput(agentId));
    if (req.url === "/event") {
      const accepted = adapter.events.includes(normalized.event)
        || (adapter.capabilities.passiveApproval && normalized.event === "PermissionRequest");
      if (!accepted || (normalized.event === "PermissionRequest" && adapter.capabilities.approval)) {
        return send(res, 400, { error: "invalid-event" });
      }
      send(res, 204, "");
      try { this.onEvent({ ...data, ...normalized }); } catch (error) { this.logger.error("Event handler failed", { message: error.message }); }
      return;
    }
    if ((normalized.kind !== "approval" && normalized.kind !== "elicitation") || !adapter.capabilities.approval) {
      return sendAdapterDecision(res, 400, agentId, noDecisionOutput(agentId));
    }
    if (!this.isApprovalEnabled(agentId) || data.codex_session_role === "subagent" || data.headless === true) {
      this.logger.info("Permission fell back to native client", {
        agentId,
        reason: !this.isApprovalEnabled() ? "disabled" : "headless",
        tool: text(data.tool_name, 160),
      });
      return sendAdapterDecision(res, 200, agentId, noDecisionOutput(agentId));
    }

    let completed = false;
    const waiter = {
      complete: decision => {
        if (completed) return;
        completed = true;
        let output;
        try { output = encodeDecision(agentId, decision, normalized); }
        catch { output = noDecisionOutput(agentId); }
        sendAdapterDecision(res, 200, agentId, output);
        this.logger.info("Permission response sent", {
          agentId,
          approvalId: entry?.id || null,
          optionId: text(decision?.optionId, 80) || "native",
          tool: normalized.toolName,
        });
      },
    };
    const result = this.approvalStore.enqueue(normalized, waiter);
    const entry = result.entry;
    this.logger.info("Permission queued", { agentId, approvalId: entry.id, tool: entry.toolName, duplicate: result.duplicate });
    res.once("close", () => {
      if (!completed) {
        completed = true;
        this.approvalStore.disconnect(entry.id, waiter);
      }
    });
  }

  async stop() {
    this.approvalStore.shutdown();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise(resolve => server.close(() => resolve()));
    }
    clearRuntime(this.ownerPid, { filePath: this.runtimePath });
    this.port = null;
    this.token = null;
    this.logger.info("Local server stopped");
  }
}

module.exports = { IslandServer, normalizePermission, readBody, safeEqual, send, sendAdapterDecision };
