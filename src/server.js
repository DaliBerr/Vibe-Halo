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
const { noDecisionOutput } = require("./codex-output");

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
  return {
    sessionId: text(data.session_id, 240) || "codex:unknown",
    toolUseId: text(data.tool_use_id, 240),
    fingerprint: text(data.tool_input_fingerprint, 128),
    toolName: text(data.tool_name, 160) || "Unknown",
    toolInput: data.tool_input && typeof data.tool_input === "object" && !Array.isArray(data.tool_input) ? data.tool_input : {},
    description: text(data.tool_input_description, 1000),
    cwd: text(data.cwd, 2000),
    sourcePid: integer(data.source_pid),
    pidChain: Array.isArray(data.pid_chain) ? data.pid_chain.map(integer).filter(Boolean).slice(0, 32) : [],
  };
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
      if (req.url === "/permission") return send(res, parsed.reason === "too-large" ? 413 : 400, noDecisionOutput());
      return send(res, parsed.reason === "too-large" ? 413 : 400, { error: parsed.reason });
    }
    const data = parsed.value;
    if (!data || data.agent_id !== "codex") return send(res, 400, req.url === "/permission" ? noDecisionOutput() : { error: "invalid-agent" });
    if (req.url === "/event") {
      if (data.event !== "Stop" && data.event !== "UserPromptSubmit") return send(res, 400, { error: "invalid-event" });
      send(res, 204, "");
      try { this.onEvent(data); } catch (error) { this.logger.error("Event handler failed", { message: error.message }); }
      return;
    }
    if (data.event !== "PermissionRequest") return send(res, 400, noDecisionOutput());
    if (!this.isApprovalEnabled() || data.codex_session_role === "subagent" || data.headless === true) {
      this.logger.info("Permission fell back to Codex", {
        reason: !this.isApprovalEnabled() ? "disabled" : "headless",
        tool: text(data.tool_name, 160),
      });
      return send(res, 200, noDecisionOutput());
    }

    let completed = false;
    const waiter = {
      complete: output => {
        if (completed) return;
        completed = true;
        send(res, 200, output);
      },
    };
    const result = this.approvalStore.enqueue(normalizePermission(data), waiter);
    const entry = result.entry;
    this.logger.info("Permission queued", { approvalId: entry.id, tool: entry.toolName, duplicate: result.duplicate });
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

module.exports = { IslandServer, normalizePermission, readBody, safeEqual, send };
