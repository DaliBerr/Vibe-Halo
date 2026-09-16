import { Fault, body, record, text, id, device, signed, fresh, hmac, normalizeCode, response, now, rate, sha256, canonical } from "./common";

export async function enroll(request: Request, env: Env): Promise<Response> {
  await rate(request, env, "enrollment", 10);
  const input = record(await body(request), ["code", "device", "proof"]);
  const code = normalizeCode(input.code);
  const pc = await device(input.device, "pc");
  const proof = await signed(input.proof, pc.signKey, "enrollment"); fresh(proof, env);
  const registrationId = id(proof.registrationId);
  if (canonical(proof.device) !== canonical(pc) || proof.codeDigest !== await sha256(code)) throw new Fault("invalid_proof", 401);
  const codeHmac = await hmac(code, env.ENROLLMENT_PEPPER);
  const existing = await env.DB.prepare("SELECT consumed_by,registration_id FROM enrollment_codes WHERE code_hmac=? AND expires_at>?").bind(codeHmac, now())
    .first<{ consumed_by: string | null; registration_id: string | null }>();
  if (!existing) throw new Fault("invalid_code", 403);
  if (existing.consumed_by) {
    const stored = await env.DB.prepare("SELECT public_json FROM devices WHERE id=? AND status='active'").bind(pc.deviceId).first<{ public_json: string }>();
    if (existing.consumed_by === pc.deviceId && existing.registration_id === registrationId && stored && canonical(JSON.parse(stored.public_json)) === canonical(pc)) return response({ deviceId: pc.deviceId, enrolled: true });
    throw new Fault("invalid_code", 403);
  }
  const capacity = Number(env.MAX_PCS) || 10;
  const result = await env.DB.batch([
    env.DB.prepare("INSERT INTO devices(id,kind,public_json,status,created_at) SELECT ?,'pc',?,'active',? FROM enrollment_codes WHERE code_hmac=? AND consumed_by IS NULL AND expires_at>? AND (SELECT COUNT(*) FROM devices WHERE kind='pc' AND status='active')<?")
      .bind(pc.deviceId, JSON.stringify(pc), now(), codeHmac, now(), capacity),
    env.DB.prepare("INSERT INTO spaces(id,pc_id) SELECT ?,id FROM devices WHERE id=? AND NOT EXISTS(SELECT 1 FROM spaces WHERE pc_id=?)").bind(`space_${pc.deviceId}`, pc.deviceId, pc.deviceId),
    env.DB.prepare("UPDATE enrollment_codes SET consumed_by=?,registration_id=? WHERE code_hmac=? AND consumed_by IS NULL AND EXISTS(SELECT 1 FROM devices WHERE id=?)").bind(pc.deviceId, registrationId, codeHmac, pc.deviceId),
  ]);
  if (result[0].meta.changes !== 1) throw new Fault("capacity_or_code_unavailable", 409);
  return response({ deviceId: pc.deviceId, enrolled: true }, 201);
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
  const expiresAt = now() + 15 * 60000;
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM device_sessions WHERE device_id=? AND expires_at<?").bind(found.device_id, now()),
    env.DB.prepare("INSERT INTO device_sessions(token_hash,device_id,expires_at) SELECT ?,?,? FROM auth_challenges WHERE id=? AND consumed=0 AND expires_at>? AND (SELECT COUNT(*) FROM device_sessions WHERE device_id=?)<5")
      .bind(await sha256(token), found.device_id, expiresAt, found.id, now(), found.device_id),
    env.DB.prepare("UPDATE auth_challenges SET consumed=1 WHERE id=? AND consumed=0").bind(found.id),
  ]);
  if (result[1].meta.changes !== 1) throw new Fault("session_unavailable", 409);
  return response({ token, expiresAt });
}
