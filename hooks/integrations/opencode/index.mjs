import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const RUNTIME_PATH = join(homedir(), ".vibe-halo", "runtime.json");
const pending = new Set();
const completed = new Set();

function runtime() {
  try {
    const value = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
    if (value?.app !== "vibe-halo" || !Number.isInteger(value.port) || typeof value.token !== "string") return null;
    try { process.kill(value.ownerPid, 0); } catch { return null; }
    return value;
  } catch { return null; }
}

async function post(route, body, timeout = 2000) {
  const value = runtime();
  if (!value) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`http://127.0.0.1:${value.port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibe-halo-token": value.token },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.headers.get("x-vibe-halo") !== "vibe-halo" || !response.ok) return null;
    return await response.text();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function equalToken(header, token) {
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header || "");
  if (!match) return false;
  const left = Buffer.from(match[1], "hex");
  const right = Buffer.from(token, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export default async function vibeHaloOpenCode(ctx) {
  const bridgeToken = randomBytes(32).toString("hex");
  const client = ctx?.client;
  const bridge = typeof Bun !== "undefined" && Bun.serve ? Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/reply") return new Response("not found", { status: 404 });
      if (!equalToken(request.headers.get("authorization"), bridgeToken)) return new Response("unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      const requestId = typeof body?.request_id === "string" ? body.request_id : "";
      const reply = typeof body?.reply === "string" ? body.reply : "";
      if (!requestId || !pending.has(requestId) || completed.has(requestId) || !["once", "always", "reject"].includes(reply)) {
        return new Response("bad or replayed request", { status: 400 });
      }
      try {
        const result = await client?._client?.post({
          url: `/permission/${encodeURIComponent(requestId)}/reply`,
          body: { reply },
          headers: { "content-type": "application/json" },
        });
        if (!result || result.error != null) return new Response("upstream failed", { status: 502 });
        completed.add(requestId);
        if (completed.size > 512) completed.delete(completed.values().next().value);
        pending.delete(requestId);
        return Response.json({ ok: true });
      } catch { return new Response("upstream failed", { status: 502 }); }
    },
  }) : null;

  const session = { id: "opencode:unknown" };
  return {
    event: async ({ event }) => {
      const properties = event?.properties || {};
      const sessionId = properties.sessionID || properties.info?.id;
      if (sessionId) session.id = String(sessionId).startsWith("opencode:") ? String(sessionId) : `opencode:${sessionId}`;
      if (event?.type === "permission.asked") {
        const requestId = typeof properties.id === "string" ? properties.id : "";
        if (!requestId || pending.has(requestId) || completed.has(requestId) || !bridge) return;
        pending.add(requestId);
        const response = await post("/permission", {
          agent_id: "opencode",
          event: "PermissionRequest",
          session_id: session.id,
          request_id: requestId,
          tool_name: properties.permission || "Unknown",
          tool_input: properties.metadata || {},
          always: Array.isArray(properties.always) && properties.always.length > 0,
          cwd: ctx?.directory || "",
          source_pid: process.pid,
        }, 135000);
        let decision = "";
        try { decision = JSON.parse(response || "").decision; } catch {}
        if (!["once", "always", "reject"].includes(decision)) { pending.delete(requestId); return; }
        await fetch(`http://127.0.0.1:${bridge.port}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` },
          body: JSON.stringify({ request_id: requestId, reply: decision }),
        }).catch(() => {});
        return;
      }
      if (event?.type === "session.status" && properties.status?.type === "busy") {
        void post("/event", { agent_id: "opencode", event: "UserPromptSubmit", session_id: session.id, cwd: ctx?.directory || "", source_pid: process.pid });
      } else if (event?.type === "session.idle") {
        void post("/event", { agent_id: "opencode", event: "Stop", session_id: session.id, cwd: ctx?.directory || "", source_pid: process.pid });
      }
    },
  };
}
