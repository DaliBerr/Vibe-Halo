import { sha256, publicDevice, verify, canonical } from "../../../packages/protocol/src/crypto.mjs";
import { safeTree } from "../../../packages/protocol/src/index.js";

export type Jwk = { kty: string; crv: string; x: string; y: string; use: string; alg: string; kid: string };
export type Device = { deviceId: string; kind: "pc" | "mobile"; name: string; signKey: Jwk; encryptionKey: Jwk };
export type Session = { device: Device; tokenHash: string; expiresAt: number };
export type Binding = { id: string; pc_id: string; mobile_id: string; scopes_json: string; revision: number; state: string; grant_jws: string; pc_ack: number };
export class Fault extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export const now = () => Date.now();
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value)) throw new Fault("invalid_id");
  return value;
}
export function text(value: unknown, maximum = 100000): string {
  if (typeof value !== "string" || !value.length || value.length > maximum) throw new Fault("invalid_structure");
  return value;
}
export function record(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Fault("invalid_structure");
  if (keys && Object.keys(value).some(key => !keys.includes(key))) throw new Fault("invalid_structure");
  return value as Record<string, unknown>;
}
export async function body(request: Request, maxBytes = 16384): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new Fault("too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new Fault("invalid_json");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Fault("too_large", 413); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!safeTree(value)) throw new Fault("invalid_structure");
    return record(value);
  } catch (error) { if (error instanceof Fault) throw error; throw new Fault("invalid_json"); }
}
export function response(value: object, status = 200): Response {
  return Response.json({ requestId: crypto.randomUUID(), ...value }, { status, headers: {
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  } });
}
export function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(bytes, byte => alphabet[byte & 31]).join("");
}
export function normalizeCode(value: unknown): string {
  const code = text(value, 100).replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{10,64}$/.test(code)) throw new Fault("invalid_code", 403);
  return code;
}
export async function hmac(value: string, pepper: string): Promise<string> {
  if (!pepper || pepper.length < 32) throw new Fault("service_unconfigured", 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function fresh(proof: Record<string, unknown>, env: Env): void {
  if (proof.protocolVersion !== 1 || proof.relayOrigin !== env.RELAY_ORIGIN
    || typeof proof.issuedAt !== "number" || Math.abs(now() - proof.issuedAt) > 30000) throw new Fault("invalid_proof", 401);
}
export async function device(value: unknown, role?: "pc" | "mobile"): Promise<Device> {
  const input = record(value, ["deviceId", "kind", "name", "signKey", "encryptionKey"]);
  for (const name of ["signKey", "encryptionKey"]) {
    const key = record(input[name], ["kty", "crv", "x", "y", "use", "alg", "kid"]);
    if (Object.keys(key).length !== 7) throw new Fault("invalid_key");
  }
  const valuePublic = await publicDevice(input);
  if (role && valuePublic.kind !== role) throw new Fault("forbidden", 403);
  return valuePublic as Device;
}
export async function signed(jws: unknown, key: Jwk, purpose: string): Promise<Record<string, unknown>> {
  try { return record(await verify(text(jws), key, purpose)); } catch { throw new Fault("invalid_proof", 401); }
}
export async function rate(request: Request, env: Env, lane: string, limit = 30): Promise<void> {
  const key = await hmac(`${lane}:${request.headers.get("cf-connecting-ip") || "local"}`, env.PAIRING_PEPPER);
  const row = await env.DB.prepare("INSERT INTO rate_limits(id,expires_at,attempts) SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM rate_limits WHERE id=?) OR (SELECT COUNT(*) FROM rate_limits)<4096 ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN expires_at<? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<? THEN ? ELSE expires_at END RETURNING attempts")
    .bind(key, now() + 300000, key, now(), now(), now() + 300000).first<{ attempts: number }>();
  if (!row || row.attempts > limit) throw new Fault("rate_limited", 429);
}
export async function sessionByHash(tokenHash: string, env: Env): Promise<Session> {
  const row = await env.DB.prepare("SELECT d.public_json,s.expires_at FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE s.token_hash=? AND s.expires_at>? AND d.status='active'")
    .bind(tokenHash, now()).first<{ public_json: string; expires_at: number }>();
  if (!row) throw new Fault("unauthorized", 401);
  const publicValue = JSON.parse(row.public_json) as Device;
  const reachable = publicValue.kind === "pc"
    ? await env.DB.prepare("SELECT id FROM spaces WHERE pc_id=? AND status='active'").bind(publicValue.deviceId).first()
    : await env.DB.prepare("SELECT id FROM bindings WHERE mobile_id=? AND state='active' LIMIT 1").bind(publicValue.deviceId).first();
  if (!reachable) throw new Fault("device_revoked", 403);
  return { device: publicValue, tokenHash, expiresAt: row.expires_at };
}
export async function authenticate(request: Request, env: Env): Promise<Session> {
  const header = request.headers.get("authorization") || "";
  if (!/^Bearer [A-Za-z0-9_-]{40,100}$/.test(header)) throw new Fault("unauthorized", 401);
  return sessionByHash(await sha256(header.slice(7)), env);
}
export async function authorize(session: Session, pcId: string, env: Env, scope = "events.read"): Promise<Binding | null> {
  if (session.device.kind === "pc") {
    if (session.device.deviceId !== pcId) throw new Fault("forbidden", 403);
    return null;
  }
  const binding = await env.DB.prepare("SELECT b.* FROM bindings b JOIN devices p ON p.id=b.pc_id JOIN spaces s ON s.pc_id=p.id WHERE b.pc_id=? AND b.mobile_id=? AND b.state='active' AND p.status='active' AND s.status='active'")
    .bind(pcId, session.device.deviceId).first<Binding>();
  if (!binding || !(JSON.parse(binding.scopes_json) as string[]).includes(scope)) throw new Fault("forbidden", 403);
  return binding;
}
export { sha256, canonical };
