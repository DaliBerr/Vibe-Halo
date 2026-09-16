import { CompactSign, compactVerify, CompactEncrypt, compactDecrypt, generateKeyPair,
  exportJWK, importJWK, calculateJwkThumbprint, decodeProtectedHeader } from "jose";
import protocol from "./index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const SCOPES = Object.freeze(["events.read", "history.read", "approvals.decide", "questions.answer", "reminders.dismiss", "approvals.persistent"]);
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function boundedJson(text, maxBytes = 65536) {
  if (typeof text !== "string" || encoder.encode(text).length > maxBytes) throw new Error("invalid_message");
  const value = JSON.parse(text);
  if (!protocol.safeTree(value)) throw new Error("invalid_message");
  return value;
}
export async function publicKey(jwk, use) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.use !== use
    || typeof jwk.x !== "string" || typeof jwk.y !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y)
    || jwk.alg !== (use === "sig" ? "ES256" : "ECDH-ES")) throw new Error("invalid_key");
  const value = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, use, alg: jwk.alg, kid: jwk.kid };
  const kid = `${use}:${await calculateJwkThumbprint(value)}`;
  if (value.kid !== kid) throw new Error("invalid_key");
  await importJWK(value, value.alg);
  return value;
}
export async function generateIdentity(kind, name = "Vibe Halo") {
  if (!["pc", "mobile"].includes(kind)) throw new Error("invalid_role");
  const keys = {};
  for (const [field, alg, use] of [["signKey", "ES256", "sig"], ["encryptionKey", "ECDH-ES", "enc"]]) {
    const pair = await generateKeyPair(alg, { crv: "P-256", extractable: true });
    const jwk = await exportJWK(pair.privateKey);
    Object.assign(jwk, { use, alg });
    jwk.kid = `${use}:${await calculateJwkThumbprint(jwk)}`;
    keys[field] = jwk;
  }
  return { deviceId: `${kind}_${crypto.randomUUID()}`, kind, name: String(name).slice(0, 48), ...keys };
}
export async function publicDevice(device) {
  if (!device || !["pc", "mobile"].includes(device.kind)
    || !new RegExp(`^${device.kind}_[a-zA-Z0-9-]{1,80}$`).test(device.deviceId)
    || typeof device.name !== "string" || device.name.length > 48) throw new Error("invalid_device");
  return { deviceId: device.deviceId, kind: device.kind, name: device.name,
    signKey: await publicKey(device.signKey, "sig"), encryptionKey: await publicKey(device.encryptionKey, "enc") };
}
export async function sign(value, privateKey, purpose) {
  const text = JSON.stringify(value);
  boundedJson(text);
  await publicKey(privateKey, "sig");
  return new CompactSign(encoder.encode(text)).setProtectedHeader({ alg: "ES256", kid: privateKey.kid, typ: `vh1:${purpose}` })
    .sign(await importJWK(privateKey, "ES256"));
}
export async function verify(jws, key, purpose) {
  if (typeof jws !== "string" || jws.length > 100000) throw new Error("invalid_signature");
  const trusted = await publicKey(key, "sig");
  const header = decodeProtectedHeader(jws);
  if (Object.keys(header).some(field => !["alg", "kid", "typ"].includes(field))
    || header.alg !== "ES256" || header.kid !== trusted.kid || header.typ !== `vh1:${purpose}`) throw new Error("invalid_signature");
  const result = await compactVerify(jws, await importJWK(trusted, "ES256"), { algorithms: ["ES256"] });
  return boundedJson(decoder.decode(result.payload));
}
export async function seal(value, senderSignKey, recipientEncryptionKey, purpose = "message") {
  const recipient = await publicKey(recipientEncryptionKey, "enc");
  const signed = await sign(value, senderSignKey, purpose);
  return new CompactEncrypt(encoder.encode(signed)).setProtectedHeader({
    alg: "ECDH-ES", enc: "A256GCM", kid: recipient.kid, typ: "vh1:encrypted", cty: "JWS",
  }).encrypt(await importJWK(recipient, "ECDH-ES"));
}
export async function open(envelope, recipientPrivateKey, senderPublicKey, purpose = "message") {
  if (typeof envelope !== "string" || envelope.length > 262144) throw new Error("invalid_envelope");
  await publicKey(recipientPrivateKey, "enc");
  const header = decodeProtectedHeader(envelope);
  if (Object.keys(header).some(field => !["alg", "enc", "kid", "typ", "cty", "epk"].includes(field))
    || header.alg !== "ECDH-ES" || header.enc !== "A256GCM" || header.kid !== recipientPrivateKey.kid
    || header.typ !== "vh1:encrypted" || header.cty !== "JWS"
    || header.epk?.kty !== "EC" || header.epk?.crv !== "P-256" || header.epk?.d) throw new Error("invalid_envelope");
  const decrypted = await compactDecrypt(envelope, await importJWK(recipientPrivateKey, "ECDH-ES"), {
    keyManagementAlgorithms: ["ECDH-ES"], contentEncryptionAlgorithms: ["A256GCM"],
  });
  return verify(decoder.decode(decrypted.plaintext), senderPublicKey, purpose);
}
export async function pairingFingerprint(transcript) {
  const hash = await sha256(canonical(transcript));
  // A 60-bit hexadecimal display, computed locally on both endpoints.
  return hash.slice(0, 15).toUpperCase().match(/.{1,5}/g).join("-");
}
export function relayOrigin(value, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
    || (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:" && ["localhost", "127.0.0.1", "10.0.2.2"].includes(url.hostname)))) throw new Error("invalid_relay_origin");
  return url.origin;
}
