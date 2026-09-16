import { SCOPES } from "../../../packages/protocol/src/crypto.mjs";
import { Fault, body, record, id, device, signed, fresh, hmac, normalizeCode, randomCode, response, now, rate, sha256, canonical, type Session, type Device } from "./common";

export type Pairing = { id: string; pc_id: string; offer_jws: string; expires_at: number; state: string; claim_json: string | null; mobile_id: string | null; grant_jws: string | null; binding_id: string | null };
export function scopes(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > SCOPES.length
    || value.some(scope => typeof scope !== "string" || !SCOPES.includes(scope)) || new Set(value).size !== value.length) throw new Fault("invalid_scopes");
  return value;
}
export async function createPairing(request: Request, env: Env, session: Session): Promise<Response> {
  if (session.device.kind !== "pc") throw new Fault("forbidden", 403);
  const input = record(await body(request), ["offer"]);
  const offer = await signed(input.offer, session.device.signKey, "pairing-offer"); fresh(offer, env);
  if (canonical(offer.pc) !== canonical(session.device) || typeof offer.lanTlsPin !== "string" || !/^[A-Za-z0-9+/=]{44}$/.test(offer.lanTlsPin)) throw new Fault("invalid_offer");
  scopes(offer.scopes);
  const pairingId = id(offer.pairingId);
  const code = randomCode();
  const expiresAt = now() + 5 * 60000;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE pc_id=? AND state='active'").bind(session.device.deviceId).first<{ n: number }>();
  if ((count?.n || 0) >= Number(env.MAX_BINDINGS_PER_PC)) throw new Fault("capacity_exceeded", 429);
  await env.DB.batch([
    env.DB.prepare("UPDATE pairings SET state='cancelled' WHERE pc_id=? AND state IN ('pending','claimed')").bind(session.device.deviceId),
    env.DB.prepare("INSERT INTO pairings(id,pc_id,code_hmac,offer_jws,expires_at) VALUES(?,?,?,?,?)").bind(pairingId, session.device.deviceId, await hmac(code, env.PAIRING_PEPPER), input.offer, expiresAt),
  ]);
  return response({ pairingId, code, expiresAt });
}

export async function claim(request: Request, env: Env): Promise<Response> {
  await rate(request, env, "claim", 10);
  const input = record(await body(request), ["code", "mobile", "proof"]);
  const code = normalizeCode(input.code);
  const mobile = await device(input.mobile, "mobile");
  const proof = await signed(input.proof, mobile.signKey, "pairing-claim"); fresh(proof, env);
  if (canonical(proof.mobile) !== canonical(mobile) || proof.codeDigest !== await sha256(code)) throw new Fault("invalid_proof", 401);
  const codeHmac = await hmac(code, env.PAIRING_PEPPER);
  const result = await env.DB.prepare("UPDATE pairings SET state='claimed',mobile_id=?,claim_json=? WHERE code_hmac=? AND state='pending' AND expires_at>? RETURNING id,offer_jws,expires_at")
    .bind(mobile.deviceId, JSON.stringify({ mobile, proof: input.proof }), codeHmac, now()).first<{ id: string; offer_jws: string; expires_at: number }>();
  if (!result) throw new Fault("invalid_code", 403);
  return response({ pairingId: result.id, offer: result.offer_jws, expiresAt: result.expires_at, state: "awaiting_pc_confirmation" });
}

export async function status(request: Request, env: Env, pairingId: string, session?: Session): Promise<Response> {
  const pairing = await env.DB.prepare("SELECT * FROM pairings WHERE id=?").bind(pairingId).first<Pairing>();
  if (!pairing) throw new Fault("not_found", 404);
  if (session) {
    if (session.device.kind !== "pc" || session.device.deviceId !== pairing.pc_id) throw new Fault("forbidden", 403);
  } else {
    await rate(request, env, "pairing-status", 120);
    const input = record(await body(request), ["proof"]);
    if (!pairing.claim_json) throw new Fault("forbidden", 403);
    const claimValue = JSON.parse(pairing.claim_json) as { mobile: Device; proof: string };
    const proof = await signed(input.proof, claimValue.mobile.signKey, "pairing-status"); fresh(proof, env);
    if (proof.pairingId !== pairingId || proof.mobileId !== pairing.mobile_id) throw new Fault("forbidden", 403);
  }
  const expired = pairing.expires_at <= now() && pairing.state !== "active";
  return response({ pairingId, state: expired ? "expired" : pairing.state === "claimed" ? "awaiting_pc_confirmation" : pairing.state,
    ...(session && pairing.claim_json ? { claim: JSON.parse(pairing.claim_json), offer: pairing.offer_jws } : {}),
    ...(pairing.state === "active" ? { grant: pairing.grant_jws } : {}), expiresAt: pairing.expires_at });
}

export async function confirm(request: Request, env: Env, pairingId: string, session: Session): Promise<Response> {
  if (session.device.kind !== "pc") throw new Fault("forbidden", 403);
  const input = record(await body(request), ["grant"]);
  const pairing = await env.DB.prepare("SELECT * FROM pairings WHERE id=? AND pc_id=?").bind(pairingId, session.device.deviceId).first<Pairing>();
  if (!pairing) throw new Fault("not_found", 404);
  if (pairing.state === "active") {
    if (pairing.grant_jws === input.grant) return response({ bindingId: pairing.binding_id, state: "active" });
    throw new Fault("pairing_conflict", 409);
  }
  if (pairing.state !== "claimed" || pairing.expires_at <= now() || !pairing.claim_json) throw new Fault("pairing_expired", 410);
  const grant = await signed(input.grant, session.device.signKey, "binding-grant");
  const offer = await signed(pairing.offer_jws, session.device.signKey, "pairing-offer");
  const claimValue = JSON.parse(pairing.claim_json) as { mobile: Device; proof: string };
  const expected = { protocolVersion: 1, relayOrigin: env.RELAY_ORIGIN, pairingId, pc: session.device, mobile: claimValue.mobile,
    lanTlsPin: offer.lanTlsPin, scopes: offer.scopes };
  for (const [key, value] of Object.entries(expected)) if (canonical(grant[key]) !== canonical(value)) throw new Fault("invalid_grant");
  const bindingId = id(grant.bindingId);
  if (grant.revision !== 1 || grant.spaceId !== `space_${session.device.deviceId}` || typeof grant.issuedAt !== "number"
    || grant.issuedAt > now() + 5000 || grant.issuedAt < pairing.expires_at - 300000) throw new Fault("invalid_grant");
  const oldDevice = await env.DB.prepare("SELECT public_json,status FROM devices WHERE id=?").bind(claimValue.mobile.deviceId).first<{ public_json: string; status: string }>();
  if (oldDevice && (oldDevice.status !== "active" || canonical(JSON.parse(oldDevice.public_json)) !== canonical(claimValue.mobile))) throw new Fault("device_conflict", 409);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("INSERT OR IGNORE INTO devices(id,kind,public_json,created_at) VALUES(?,'mobile',?,?)").bind(claimValue.mobile.deviceId, JSON.stringify(claimValue.mobile), now()),
    env.DB.prepare("DELETE FROM bindings WHERE pc_id=? AND mobile_id=? AND state='revoked'").bind(session.device.deviceId, claimValue.mobile.deviceId),
    env.DB.prepare("INSERT INTO bindings(id,pc_id,mobile_id,scopes_json,revision,grant_jws) SELECT ?,?,?,?,?,? FROM pairings WHERE id=? AND state='claimed' AND expires_at>? AND (SELECT COUNT(*) FROM bindings WHERE pc_id=? AND state='active')<?")
      .bind(bindingId, session.device.deviceId, claimValue.mobile.deviceId, JSON.stringify(scopes(grant.scopes)), 1, input.grant, pairingId, now(), session.device.deviceId, Number(env.MAX_BINDINGS_PER_PC)),
    env.DB.prepare("UPDATE pairings SET state='active',grant_jws=?,binding_id=? WHERE id=? AND state='claimed' AND EXISTS(SELECT 1 FROM bindings WHERE id=?)")
      .bind(input.grant, bindingId, pairingId, bindingId),
  ];
  const results = await env.DB.batch(statements);
  if (results[2].meta.changes !== 1) throw new Fault("pairing_conflict", 409);
  return response({ bindingId, state: "active" }, 201);
}
