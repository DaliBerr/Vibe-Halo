import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function runtime() {
  try {
    const value = JSON.parse(readFileSync(join(homedir(), ".vibe-halo", "runtime.json"), "utf8"));
    if (value?.app !== "vibe-halo" || !Number.isInteger(value.port) || typeof value.token !== "string") return null;
    process.kill(value.ownerPid, 0);
    return value;
  } catch { return null; }
}

function sessionId(event, ctx) {
  const value = event?.sessionId || ctx?.sessionId || event?.sessionKey || ctx?.sessionKey || "default";
  return String(value).startsWith("openclaw:") ? String(value) : `openclaw:${value}`;
}

function post(eventName, event, ctx) {
  const value = runtime();
  if (!value) return;
  void fetch(`http://127.0.0.1:${value.port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibe-halo-token": value.token },
    body: JSON.stringify({ agent_id: "openclaw", event: eventName, session_id: sessionId(event, ctx), cwd: ctx?.cwd || "", source_pid: process.pid }),
  }).catch(() => {});
}

export default {
  id: "vibe-halo",
  name: "Vibe Halo",
  register(api) {
    if (!api || typeof api.on !== "function") return;
    api.on("model_call_started", (event, ctx) => post("UserPromptSubmit", event, ctx), { priority: -100, timeoutMs: 1000 });
    api.on("model_call_ended", (event, ctx) => post("Stop", event, ctx), { priority: -100, timeoutMs: 1000 });
  },
};
