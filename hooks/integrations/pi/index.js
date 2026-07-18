"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

function runtime() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".vibe-halo", "runtime.json"), "utf8"));
    if (value?.app !== "vibe-halo" || !Number.isInteger(value.port) || typeof value.token !== "string") return null;
    process.kill(value.ownerPid, 0);
    return value;
  } catch { return null; }
}

function send(event, ctx) {
  const value = runtime();
  if (!value) return Promise.resolve(false);
  const manager = ctx?.sessionManager;
  let rawId = "default";
  try { rawId = manager?.getSessionId?.() || manager?.getSessionFile?.() || rawId; } catch {}
  const body = JSON.stringify({
    agent_id: "pi", event, session_id: `pi:${String(rawId).slice(0, 220)}`,
    cwd: ctx?.cwd || process.cwd(), source_pid: process.pid, pid_chain: [process.pid],
  });
  return new Promise(resolve => {
    const request = http.request({
      hostname: "127.0.0.1", port: value.port, path: "/event", method: "POST", timeout: 1800,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-vibe-halo-token": value.token },
    }, response => { response.resume(); response.on("end", () => resolve(response.headers["x-vibe-halo"] === "vibe-halo")); });
    request.on("error", () => resolve(false));
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.end(body);
  });
}

module.exports = function vibeHaloPi(pi) {
  if (!pi || typeof pi.on !== "function") return;
  pi.on("before_agent_start", (_event, ctx) => { void send("UserPromptSubmit", ctx); });
  pi.on("agent_end", (_event, ctx) => send("Stop", ctx));
};
