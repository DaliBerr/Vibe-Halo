import { Fault, body, record, text, id, device, signed, fresh, response, now, rate, sha256, canonical } from "./common";

export async function enroll(request: Request, env: Env): Promise<Response> {
  await rate(request, env, "enrollment", 10);
  const input = record(await body(request), ["device", "proof"]);
  const pc = await device(input.device, "pc");
  const proof = await signed(input.proof, pc.signKey, "enrollment"); fresh(proof, env);
  id(proof.registrationId);
  if (canonical(proof.device) !== canonical(pc)) throw new Fault("invalid_proof", 401);
  const capacity = Math.max(0, Math.min(10000, Number(env.MAX_PCS) || 0));
  const publicJson = JSON.stringify(pc);
  // The capacity check and insert run in one transaction. Existing identities can
  // retry a lost response even after registration closes; keys are never replaced.
  const result = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("INSERT INTO devices(id,kind,public_json,status,created_at) SELECT ?,'pc',?,'active',? WHERE EXISTS(SELECT 1 FROM relay_settings WHERE id='registration' AND value='open') AND (SELECT COUNT(*) FROM devices WHERE kind='pc' AND status='active')<? ON CONFLICT(id) DO NOTHING")
      .bind(pc.deviceId, publicJson, now(), capacity),
    env.DB.prepare("INSERT INTO spaces(id,pc_id) SELECT ?,id FROM devices WHERE id=? AND status='active' AND public_json=? ON CONFLICT(pc_id) DO NOTHING").bind(`space_${pc.deviceId}`, pc.deviceId, publicJson),
    env.DB.prepare("SELECT d.public_json,d.status,s.status AS space_status FROM devices d LEFT JOIN spaces s ON s.pc_id=d.id WHERE d.id=?").bind(pc.deviceId),
    env.DB.prepare("SELECT value FROM relay_settings WHERE id='registration'"),
  ]);
  const stored = result[2].results[0];
  if (stored) {
    if (stored.status !== "active" || stored.space_status !== "active") throw new Fault("device_revoked", 403);
    if (canonical(JSON.parse(String(stored.public_json))) !== canonical(pc)) throw new Fault("identity_conflict", 409);
    return response({ deviceId: pc.deviceId, enrolled: true }, result[0].meta.changes === 1 ? 201 : 200);
  }
  throw new Fault(result[3].results[0]?.value === "open" ? "capacity_exceeded" : "registration_closed", 503);
}

export async function challenge(request: Request, env: Env): Promise<Response> {
  await rate(request, env, "challenge", 60);
  const input = record(await body(request), ["deviceId"]);
  const deviceId = id(input.deviceId);
  const found = await env.DB.prepare("SELECT public_json FROM devices WHERE id=? AND status='active'").bind(deviceId).first<{ public_json: string }>();
  if (!found) throw new Fault("unauthorized", 401);
  const value = { protocolVersion: 1, relayOrigin: env.RELAY_ORIGIN, purpose: "device-session", challengeId: crypto.randomUUID(), deviceId,
    keyId: JSON.parse(found.public_json).signKey.kid, nonce: crypto.randomUUID(), expiresAt: now() + 60000 };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE device_id=? AND (expires_at<? OR consumed=1)").bind(deviceId, now()),
    env.DB.prepare("INSERT INTO auth_challenges(id,device_id,challenge_json,expires_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM auth_challenges WHERE device_id=?)<5")
      .bind(value.challengeId, deviceId, JSON.stringify(value), value.expiresAt, deviceId),
  ]);
  const inserted = await env.DB.prepare("SELECT id FROM auth_challenges WHERE id=?").bind(value.challengeId).first();
  if (!inserted) throw new Fault("rate_limited", 429);
  return response({ challenge: value });
}

export async function createSession(request: Request, env: Env): Promise<Response> {
  await rate(request, env, "session", 60);
  const input = record(await body(request), ["challengeId", "proof"]);
  const found = await env.DB.prepare("SELECT c.*,d.public_json FROM auth_challenges c JOIN devices d ON d.id=c.device_id WHERE c.id=? AND c.consumed=0 AND c.expires_at>? AND d.status='active'")
    .bind(id(input.challengeId), now()).first<{ id: string; device_id: string; challenge_json: string; public_json: string }>();
  if (!found) throw new Fault("invalid_challenge", 401);
  const value = await signed(input.proof, JSON.parse(found.public_json).signKey, "device-session");
  if (canonical(value) !== canonical(JSON.parse(found.challenge_json))) throw new Fault("invalid_proof", 401);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
  // Keep immediate DB-backed revocation, but avoid synchronized renewal storms.
  const expiresAt = now() + (60 * 60 + Math.floor(Math.random() * 15 * 60)) * 1000;
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM device_sessions WHERE device_id=? AND expires_at<?").bind(found.device_id, now()),
    env.DB.prepare("INSERT INTO device_sessions(token_hash,device_id,expires_at) SELECT ?,?,? FROM auth_challenges WHERE id=? AND consumed=0 AND expires_at>? AND (SELECT COUNT(*) FROM device_sessions WHERE device_id=?)<5")
      .bind(await sha256(token), found.device_id, expiresAt, found.id, now(), found.device_id),
    env.DB.prepare("UPDATE auth_challenges SET consumed=1 WHERE id=? AND consumed=0").bind(found.id),
  ]);
  if (result[1].meta.changes !== 1) throw new Fault("session_unavailable", 409);
  return response({ token, expiresAt });
}
