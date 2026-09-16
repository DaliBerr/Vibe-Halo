import { importPKCS8, SignJWT } from "jose";
import { Fault, body, record, text, response, now, authorize, type Session } from "./common";

async function tokenKey(env: Env): Promise<CryptoKey> {
  try {
    const raw = Uint8Array.from(atob(env.PUSH_TOKEN_KEY), c => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { throw new Fault("push_unconfigured", 503); }
}
export async function encryptToken(token: string, deviceId: string, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(deviceId) }, await tokenKey(env), new TextEncoder().encode(token));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(ciphertext)));
}
async function decryptToken(value: string, deviceId: string, env: Env): Promise<string> {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(deviceId) }, await tokenKey(env), bytes.slice(12));
  return new TextDecoder().decode(raw);
}
export async function registerPush(request: Request, env: Env, session: Session): Promise<Response> {
  if (session.device.kind !== "mobile") throw new Fault("forbidden", 403);
  const deviceId = session.device.deviceId;
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM push_tokens WHERE device_id=?").bind(deviceId).run();
    return response({ registered: false });
  }
  const input = record(await body(request), ["token", "revision"]);
  const token = text(input.token, 4096), revision = input.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Fault("invalid_revision");
  const ciphertext = await encryptToken(token, deviceId, env);
  const result = await env.DB.prepare("INSERT INTO push_tokens(device_id,ciphertext,revision,updated_at,active) VALUES(?,?,?,?,1) ON CONFLICT(device_id) DO UPDATE SET ciphertext=excluded.ciphertext,revision=excluded.revision,updated_at=excluded.updated_at,active=1 WHERE excluded.revision>push_tokens.revision")
    .bind(deviceId, ciphertext, revision, now()).run();
  return response({ registered: true, changed: result.meta.changes > 0, pushEnabled: String(env.FCM_ENABLED) === "true" });
}
export async function preferences(request: Request, env: Env, session: Session, pcId: string): Promise<Response> {
  await authorize(session, pcId, env);
  if (session.device.kind !== "mobile") throw new Fault("forbidden", 403);
  const input = record(await body(request), ["enabled", "approvals", "questions", "completions", "revision"]);
  for (const key of ["enabled", "approvals", "questions", "completions"]) if (typeof input[key] !== "boolean") throw new Fault("invalid_preferences");
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new Fault("invalid_revision");
  await env.DB.prepare("INSERT INTO notification_preferences(mobile_id,pc_id,value_json,revision) VALUES(?,?,?,?) ON CONFLICT(mobile_id,pc_id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision WHERE excluded.revision>notification_preferences.revision")
    .bind(session.device.deviceId, pcId, JSON.stringify(input), input.revision).run();
  return response({ saved: true });
}

let oauth: { key: string; token: string; expiresAt: number } | undefined;
async function accessToken(env: Env): Promise<string> {
  const cacheKey = `${env.FCM_PROJECT_ID}:${env.FCM_CLIENT_EMAIL}`;
  if (oauth?.key === cacheKey && oauth.expiresAt > now() + 60000) return oauth.token;
  if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) throw new Fault("push_unconfigured", 503);
  const key = await importPKCS8(env.FCM_PRIVATE_KEY.replace(/\\n/g, "\n"), "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(env.FCM_CLIENT_EMAIL)
    .setAudience("https://oauth2.googleapis.com/token").setIssuedAt().setExpirationTime("1h").sign(key);
  const result = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!result.ok) throw new Fault("push_auth_failed", 503);
  const data = await result.json() as { access_token: string; expires_in: number };
  if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in)) throw new Fault("push_auth_failed", 503);
  oauth = { key: cacheKey, token: data.access_token, expiresAt: now() + Math.min(data.expires_in, 3600) * 1000 };
  return oauth.token;
}
export async function deliverPush(env: Env, pcId: string, mobileId: string, summary: Record<string, unknown>, current = () => true, retryAfter = (_milliseconds: number) => {}): Promise<"sent" | "skip" | "retry"> {
  if (String(env.FCM_ENABLED) !== "true") return "skip";
  const binding = await env.DB.prepare("SELECT b.id FROM bindings b JOIN spaces s ON s.pc_id=b.pc_id JOIN devices d ON d.id=b.pc_id WHERE b.pc_id=? AND b.mobile_id=? AND b.state='active' AND s.status='active' AND d.status='active'").bind(pcId, mobileId).first();
  if (!binding) return "skip";
  const preferences = await env.DB.prepare("SELECT value_json FROM notification_preferences WHERE pc_id=? AND mobile_id=?").bind(pcId, mobileId).first<{ value_json: string }>();
  const pref = preferences ? JSON.parse(preferences.value_json) : { enabled: true, approvals: true, questions: true, completions: true };
  const category = summary.kind === "approval" ? "approvals" : summary.kind === "question" || summary.kind === "input" ? "questions" : "completions";
  if (!pref.enabled || !pref[category]) return "skip";
  const row = await env.DB.prepare("SELECT ciphertext,revision FROM push_tokens WHERE device_id=? AND active=1").bind(mobileId).first<{ ciphertext: string; revision: number }>();
  if (!row) return "skip";
  try {
    const token = await decryptToken(row.ciphertext, mobileId, env);
    const ttl = Math.max(0, Math.min(600, Math.floor((Date.parse(String(summary.expiresAt)) - now()) / 1000)));
    if (!ttl) return "skip";
    const access = await accessToken(env);
    if (!current() || Date.parse(String(summary.expiresAt)) <= now()) return "skip";
    const stillBound = await env.DB.prepare("SELECT id FROM bindings WHERE pc_id=? AND mobile_id=? AND state='active'").bind(pcId, mobileId).first();
    if (!stillBound || !current()) return "skip";
    const result = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID)}/messages:send`, {
      method: "POST", signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token,
        notification: { title: "Vibe Halo", body: category === "completions" ? "有一项进展可查看 · An update is ready" : "有一项请求待查看 · A request needs attention" },
        data: { protocolVersion: "1", pcId, pcSessionEpoch: String(summary.pcSessionEpoch), eventId: String(summary.eventId), eventRevision: String(summary.eventRevision), kind: String(summary.kind) },
        android: { priority: category === "completions" ? "NORMAL" : "HIGH", ttl: `${ttl}s`, collapse_key: pcId,
          notification: { channel_id: category, tag: `${pcId}/${summary.eventId}`, visibility: "PRIVATE", default_sound: true } } } }),
    });
    if (result.ok) return "sent";
    const retryHeader = result.headers.get("retry-after");
    if (retryHeader) {
      const delay = /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - now();
      if (Number.isFinite(delay)) retryAfter(Math.max(0, Math.min(delay, 3600000)));
    }
    if (result.status === 401) { oauth = undefined; return "retry"; }
    const error = await result.json().catch(() => ({})) as { error?: { details?: { errorCode?: string }[] } };
    if ([400, 404].includes(result.status) && error.error?.details?.some(detail => detail.errorCode === "UNREGISTERED")) {
      await env.DB.prepare("UPDATE push_tokens SET active=0 WHERE device_id=? AND revision=?").bind(mobileId, row.revision).run();
      return "skip";
    }
    return result.status === 429 || result.status >= 500 ? "retry" : "skip";
  } catch { return "retry"; }
}
