import { enroll, challenge, createSession } from "./auth";
import { createPairing, claim, status, confirm } from "./pairing";
import { registerPush, preferences } from "./push";
import { updateProfile } from "./device-profile";
import { Fault, authenticate, authorize, body, record, id, text, response, now, sha256, type Binding } from "./common";
export { Relay } from "./relay-do";
function relayResponse(value: object, status = 200): Response {
  if ("relayError" in value && "relayStatus" in value) throw new Fault(String(value.relayError), Number(value.relayStatus));
  return response(value, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url), route = url.pathname;
      if (route === "/healthz" && request.method === "GET") return response({ service: "vibe-halo-relay", protocolVersion: 1, capacity: { registeredActivePcs: Number(env.MAX_PCS), mobilesPerPc: Number(env.MAX_BINDINGS_PER_PC) } });
      // Cheap edge protection runs before database authentication. This is per-colo,
      // not a global daily quota or a substitute for authoritative DB checks.
      if (!(await env.INGRESS_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") || "local" })).success) throw new Fault("rate_limited", 429);
      const bearer = request.headers.get("authorization") || "";
      if (/^Bearer [A-Za-z0-9_-]{40,100}$/.test(bearer)
        && !(await env.DEVICE_LIMIT.limit({ key: await sha256(bearer) })).success) throw new Fault("rate_limited", 429);
      if (route === "/v1/enrollments" && request.method === "POST") return await enroll(request, env);
      if (route === "/v1/auth/challenge" && request.method === "POST") return await challenge(request, env);
      if (route === "/v1/auth/session" && request.method === "POST") return await createSession(request, env);
      if (route === "/v1/pairings/claim" && request.method === "POST") return await claim(request, env);
      const pairingPath = /^\/v1\/pairings\/([A-Za-z0-9_.:-]+)\/(status|confirm|cancel)$/.exec(route);
      if (pairingPath?.[2] === "status" && request.method === "POST") return await status(request, env, pairingPath[1]);
      const session = await authenticate(request, env);
      if (route === "/v1/device-profile" && request.method === "PUT") return await updateProfile(request, env, session);
      if (route === "/v1/push-token" && ["PUT", "DELETE"].includes(request.method)) return await registerPush(request, env, session);
      const preferencesPath = /^\/v1\/pcs\/([A-Za-z0-9_.:-]+)\/notification-preferences$/.exec(route);
      if (preferencesPath && request.method === "PUT") return await preferences(request, env, session, preferencesPath[1]);
      if (route === "/v1/auth/session" && request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM device_sessions WHERE token_hash=?").bind(session.tokenHash).run(); return response({ revoked: true });
      }
      if (route === "/v1/pairings" && request.method === "POST") return await createPairing(request, env, session);
      if (pairingPath) {
        if (pairingPath[2] === "status" && request.method === "GET") return await status(request, env, pairingPath[1], session);
        if (pairingPath[2] === "confirm" && request.method === "POST") return await confirm(request, env, pairingPath[1], session);
        if (pairingPath[2] === "cancel" && request.method === "POST" && session.device.kind === "pc") {
          await env.DB.prepare("UPDATE pairings SET state='cancelled' WHERE id=? AND pc_id=? AND state IN ('pending','claimed')").bind(pairingPath[1], session.device.deviceId).run(); return response({ cancelled: true });
        }
      }
      if (route === "/v1/devices" && request.method === "GET") {
        const column = session.device.kind === "pc" ? "pc_id" : "mobile_id";
        const result = await env.DB.prepare(`SELECT b.*,p.public_json AS pc_json,m.public_json AS mobile_json,pp.profile_jws AS pc_profile,mp.profile_jws AS mobile_profile FROM bindings b JOIN devices p ON p.id=b.pc_id JOIN devices m ON m.id=b.mobile_id LEFT JOIN device_profiles pp ON pp.device_id=p.id LEFT JOIN device_profiles mp ON mp.device_id=m.id WHERE b.${column}=? LIMIT 64`).bind(session.device.deviceId).all();
        return response({ bindings: result.results });
      }
      const bindingPath = /^\/v1\/bindings\/([A-Za-z0-9_.:-]+)$/.exec(route);
      const ackPath = /^\/v1\/bindings\/([A-Za-z0-9_.:-]+)\/ack$/.exec(route);
      if (ackPath && request.method === "POST" && session.device.kind === "pc") {
        const result = await env.DB.prepare("UPDATE bindings SET pc_ack=1 WHERE id=? AND pc_id=? AND state='revoked'").bind(ackPath[1], session.device.deviceId).run();
        if (!result.meta.changes) throw new Fault("not_found", 404);
        return response({ pcAcknowledged: true });
      }
      if (bindingPath && request.method === "DELETE") {
        const binding = await env.DB.prepare("SELECT * FROM bindings WHERE id=? AND (pc_id=? OR mobile_id=?)").bind(bindingPath[1], session.device.deviceId, session.device.deviceId).first<Binding>();
        if (!binding) throw new Fault("not_found", 404);
        await env.DB.prepare("UPDATE bindings SET state='revoked',revision=revision+1,pc_ack=? WHERE id=? AND state='active'").bind(session.device.kind === "pc" ? 1 : 0, binding.id).run();
        await env.RELAY.getByName(binding.pc_id).invalidate(binding.id);
        return response({ state: "revoked", pcAcknowledged: session.device.kind === "pc" });
      }
      const pcPath = /^\/v1\/pcs\/([A-Za-z0-9_.:-]+)\/(stream|events|decisions|queries)(?:\/([A-Za-z0-9_.:-]+))?$/.exec(route);
      if (pcPath) {
        const pcId = pcPath[1]; await authorize(session, pcId, env);
        const relay = env.RELAY.getByName(pcId);
        if (pcPath[2] === "stream" && request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const headers = new Headers({ upgrade: "websocket", "x-vibe-identity": JSON.stringify({ pcId, tokenHash: session.tokenHash, deviceId: session.device.deviceId, kind: session.device.kind, expiresAt: session.expiresAt }) });
          return await relay.fetch(new Request("https://internal/stream", { headers }));
        }
        if (pcPath[2] === "events" && request.method === "GET") {
          const offset = Number(url.searchParams.get("offset") || "0");
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > 500) throw new Fault("invalid_cursor");
          return relayResponse(await relay.list(pcId, session.tokenHash, offset));
        }
        if (pcPath[2] === "decisions" && request.method === "POST" && !pcPath[3]) {
          const input = record(await body(request, 262144), ["decisionId", "envelope"]);
          return relayResponse(await relay.submit(pcId, session.tokenHash, id(input.decisionId), text(input.envelope, 262144)), 202);
        }
        if (pcPath[2] === "decisions" && request.method === "GET" && pcPath[3]) return relayResponse(await relay.receipt(pcId, session.tokenHash, pcPath[3]));
        if (pcPath[2] === "queries" && request.method === "POST" && !pcPath[3]) {
          const input = record(await body(request, 262144), ["requestId", "envelope"]);
          return relayResponse(await relay.query(pcId, session.tokenHash, id(input.requestId), text(input.envelope, 262144)), 202);
        }
        if (pcPath[2] === "queries" && request.method === "GET" && pcPath[3]) return relayResponse(await relay.query(pcId, session.tokenHash, pcPath[3]));
      }
      throw new Fault("not_found", 404);
    } catch (error) {
      if (!(error instanceof Fault)) console.error(JSON.stringify({ code: "relay_dependency_failure" }));
      else if ([429, 503].includes(error.status)) console.warn(JSON.stringify({ code: error.code, status: error.status }));
      return response({ error: error instanceof Fault ? error.code : "service_unavailable" }, error instanceof Fault ? error.status : 503);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cutoff = now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at<?").bind(cutoff),
      env.DB.prepare("DELETE FROM device_sessions WHERE expires_at<?").bind(cutoff),
      env.DB.prepare("DELETE FROM pairings WHERE expires_at<?").bind(cutoff - 86400000),
      env.DB.prepare("DELETE FROM enrollment_codes WHERE expires_at<?").bind(cutoff - 86400000),
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(cutoff),
      env.DB.prepare("DELETE FROM security_audit WHERE created_at<?").bind(cutoff - 30 * 86400000),
    ]);
  },
} satisfies ExportedHandler<Env>;
