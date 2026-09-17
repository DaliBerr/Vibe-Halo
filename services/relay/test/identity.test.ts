import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { generateIdentity, publicDevice, sign, sha256, canonical } from "../../../packages/protocol/src/crypto.mjs";
import { hmac } from "../src/common";
import { deliverPush, encryptToken, notificationCopy } from "../src/push";
import { generateKeyPair, exportPKCS8 } from "jose";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { await env.DB.prepare("DELETE FROM rate_limits").run(); });
const origin = "https://relay.test";
const post = (path: string, data: object, token?: string) => SELF.fetch(origin + path, { method: "POST", headers: {
  "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
}, body: JSON.stringify(data) });
const privateHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

async function enrolled() {
  const pc = await generateIdentity("pc"); const publicPc = await publicDevice(pc);
  const request = { device: publicPc, proof: await sign({ protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), registrationId: crypto.randomUUID(), device: publicPc }, pc.signKey, "enrollment") };
  const result = await post("/v1/enrollments", request);
  expect(result.status).toBe(201);
  return { pc, publicPc, request, token: await login(pc) };
}
async function login(identity: Awaited<ReturnType<typeof generateIdentity>>) {
  const result = await post("/v1/auth/challenge", { deviceId: identity.deviceId });
  const { challenge } = await result.json<{ challenge: object & { challengeId: string } }>();
  const session = await post("/v1/auth/session", { challengeId: challenge.challengeId, proof: await sign(challenge, identity.signKey, "device-session") });
  expect(session.status).toBe(200);
  return (await session.json<{ token: string }>()).token;
}
async function paired(existingRoot?: Awaited<ReturnType<typeof enrolled>>, existingMobile?: Awaited<ReturnType<typeof generateIdentity>>, race = false) {
  const root = existingRoot || await enrolled(); const mobile = existingMobile || await generateIdentity("mobile"); const publicMobile = await publicDevice(mobile);
  const pairingId = crypto.randomUUID();
  const offer = { protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), pairingId, pc: root.publicPc, lanTlsPin: "A".repeat(43) + "=", scopes: ["events.read", "history.read", "approvals.decide", "questions.answer"] };
  const created = await post("/v1/pairings", { offer: await sign(offer, root.pc.signKey, "pairing-offer") }, root.token);
  expect(created.status).toBe(200);
  const { code } = await created.json<{ code: string }>();
  const claimPayload = { code, mobile: publicMobile, proof: await sign({ protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), mobile: publicMobile, codeDigest: await sha256(code) }, mobile.signKey, "pairing-claim") };
  if (race) {
    const results = await Promise.all([post("/v1/pairings/claim", claimPayload), post("/v1/pairings/claim", claimPayload)]);
    expect(results.map(value => value.status).sort()).toEqual([200, 403]);
  } else expect((await post("/v1/pairings/claim", claimPayload)).status).toBe(200);
  const grant = { protocolVersion: 1, relayOrigin: origin, pairingId, pc: root.publicPc, mobile: publicMobile,
    lanTlsPin: offer.lanTlsPin, scopes: offer.scopes, spaceId: `space_${root.pc.deviceId}`, bindingId: crypto.randomUUID(), revision: 1, issuedAt: Date.now() };
  const grantJws = await sign(grant, root.pc.signKey, "binding-grant");
  return { ...root, mobile, pairingId, grant, grantJws, claimPayload };
}

describe("device identity and pairing", () => {
  it("syncs signed display names without replacing identity or grants and rejects replay/forgery", async () => {
    const pairedRoot = await paired();
    expect((await post(`/v1/pairings/${pairedRoot.pairingId}/confirm`, { grant: pairedRoot.grantJws }, pairedRoot.token)).status).toBe(201);
    const mobileToken = await login(pairedRoot.mobile);
    const write = async (identity: typeof pairedRoot.pc, token: string, revision: number, name: string, deviceId = identity.deviceId) => {
      const profile = await sign({ protocolVersion: 1, relayOrigin: origin, deviceId, revision, name }, identity.signKey, "device-profile");
      return SELF.fetch(origin + "/v1/device-profile", { method: "PUT", headers: { ...privateHeaders(token), "content-type": "application/json" }, body: JSON.stringify({ profile }) });
    };
    expect((await write(pairedRoot.pc, pairedRoot.token, 2, "RETARD" )).status).toBe(200);
    expect((await write(pairedRoot.pc, pairedRoot.token, 2, "RETARD" )).status).toBe(200);
    expect((await write(pairedRoot.pc, pairedRoot.token, 1, "old" )).status).toBe(409);
    expect((await write(pairedRoot.pc, pairedRoot.token, 2, "changed" )).status).toBe(409);
    expect((await write(pairedRoot.mobile, mobileToken, 1, "小米 15" )).status).toBe(200);
    expect((await write(pairedRoot.mobile, mobileToken, 3, "forged", pairedRoot.pc.deviceId)).status).toBe(400);
    expect((await write(pairedRoot.pc, mobileToken, 3, "forged")).status).toBe(401);
    expect((await write(pairedRoot.pc, pairedRoot.token, 3, "bad\nname")).status).toBe(400);
    const list = await SELF.fetch(origin + "/v1/devices", { headers: privateHeaders(mobileToken) });
    const data = await list.json<{bindings: {grant_jws:string;pc_json:string;pc_profile:string;mobile_profile:string}[]}>();
    expect(data.bindings[0].grant_jws).toBe(pairedRoot.grantJws);
    expect(JSON.parse(data.bindings[0].pc_json)).toEqual(pairedRoot.publicPc);
    expect(data.bindings[0].pc_profile).toBeTruthy(); expect(data.bindings[0].mobile_profile).toBeTruthy();
    expect(await login(pairedRoot.pc)).toBeTruthy();
    await env.DB.prepare("UPDATE devices SET status='revoked' WHERE id=?").bind(pairedRoot.pc.deviceId).run();
  });
  it("registers without a code, retries safely, and rejects replaced keys and revoked devices", async () => {
    const root = await enrolled();
    expect((await post("/v1/enrollments", root.request)).status).toBe(200);
    const stranger = await generateIdentity("pc"), device = { ...await publicDevice(stranger), deviceId: root.pc.deviceId };
    const forged = { device, proof: await sign({ protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), registrationId: crypto.randomUUID(), device }, stranger.signKey, "enrollment") };
    expect((await post("/v1/enrollments", forged)).status).toBe(409);
    await env.DB.prepare("UPDATE devices SET status='revoked' WHERE id=?").bind(root.pc.deviceId).run();
    expect((await post("/v1/enrollments", root.request)).status).toBe(403);
  });
  it("keeps registration management outside the public API and honors closure without breaking retries", async () => {
    const root = await enrolled();
    await env.DB.prepare("UPDATE relay_settings SET value='closed' WHERE id='registration'").run();
    try {
      expect((await post("/v1/enrollments", root.request)).status).toBe(200);
      const pc = await generateIdentity("pc"), device = await publicDevice(pc);
      const proof = await sign({ protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), registrationId: crypto.randomUUID(), device }, pc.signKey, "enrollment");
      const closed = await post("/v1/enrollments", {device, proof});
      expect(closed.status).toBe(503); expect((await closed.json<{error:string}>()).error).toBe("registration_closed");
      expect((await post("/v1/admin/open-registration", {}, root.token)).status).toBe(404);
    } finally { await env.DB.prepare("UPDATE relay_settings SET value='open' WHERE id='registration'").run(); }
  });
  it("rejects forged registration and limits unauthenticated attempts", async () => {
    const pc = await generateIdentity("pc"), device = await publicDevice(pc);
    const proof = await sign({ protocolVersion: 1, relayOrigin: "https://other.test", issuedAt: Date.now(), registrationId: crypto.randomUUID(), device }, pc.signKey, "enrollment");
    for (let n=0;n<10;n++) expect((await post("/v1/enrollments", {device,proof})).status).toBe(401);
    expect((await post("/v1/enrollments", {device,proof})).status).toBe(429);
  });
  it("consumes challenge exactly once and rejects cross-service proof", async () => {
    const root = await enrolled();
    const { challenge } = await (await post("/v1/auth/challenge", { deviceId: root.pc.deviceId })).json<{ challenge: object & { challengeId: string } }>();
    for (const altered of [{ ...challenge, relayOrigin: "https://another.test" }, { ...challenge, deviceId: "pc_wrong" }, { ...challenge, purpose: "pairing-claim" }]) {
      expect((await post("/v1/auth/session", { challengeId: challenge.challengeId, proof: await sign(altered, root.pc.signKey, "device-session") })).status).toBe(401);
    }
    const input = { challengeId: challenge.challengeId, proof: await sign(challenge, root.pc.signKey, "device-session") };
    const statuses = await Promise.all([post("/v1/auth/session", input), post("/v1/auth/session", input)]);
    expect(statuses.filter(result => result.status === 200)).toHaveLength(1);
  });
  it("keeps a claimed phone outside business APIs until local PC confirmation", async () => {
    const pair = await paired(undefined, undefined, true);
    expect((await post("/v1/pairings/claim", pair.claimPayload)).status).toBe(403);
    expect((await post("/v1/auth/challenge", { deviceId: pair.mobile.deviceId })).status).toBe(401);
    expect((await post(`/v1/pairings/${pair.pairingId}/confirm`, { grant: pair.grantJws }, pair.token)).status).toBe(201);
    const mobileToken = await login(pair.mobile);
    const devices = await SELF.fetch(origin + "/v1/devices", { headers: privateHeaders(mobileToken) });
    expect(devices.status).toBe(200);
    const result = await devices.json<{ bindings: { id: string; grant_jws: string }[] }>();
    expect(result.bindings.map(value => value.id)).toContain(pair.grant.bindingId);
    expect((await post(`/v1/pairings/${pair.pairingId}/confirm`, { grant: pair.grantJws }, pair.token)).status).toBe(200);
    const other = await enrolled();
    expect((await SELF.fetch(origin + `/v1/pcs/${other.pc.deviceId}/events`, { headers: privateHeaders(mobileToken) })).status).toBe(403);
  });
  it("rejects changed pairing keys/scopes and replay after binding revocation", async () => {
    const pair = await paired();
    const tampered = await sign({ ...pair.grant, scopes: ["events.read", "approvals.persistent"] }, pair.pc.signKey, "binding-grant");
    expect((await post(`/v1/pairings/${pair.pairingId}/confirm`, { grant: tampered }, pair.token)).status).toBe(400);
    await post(`/v1/pairings/${pair.pairingId}/confirm`, { grant: pair.grantJws }, pair.token);
    const token = await login(pair.mobile);
    expect((await SELF.fetch(origin + `/v1/bindings/${pair.grant.bindingId}`, { method: "DELETE", headers: privateHeaders(pair.token) })).status).toBe(200);
    expect((await SELF.fetch(origin + `/v1/pcs/${pair.pc.deviceId}/events`, { headers: privateHeaders(token) })).status).toBe(403);
    const expired = await paired(pair);
    await env.DB.prepare("UPDATE pairings SET expires_at=0 WHERE id=?").bind(expired.pairingId).run();
    expect((await post(`/v1/pairings/${expired.pairingId}/confirm`, { grant: expired.grantJws }, expired.token)).status).toBe(410);
    expect((await post("/v1/pairings/claim", expired.claimPayload)).status).toBe(403);
  });
  it("isolates two PCs and three phones and revokes only the selected relationship", async () => {
    const pcs = [await enrolled(), await enrolled()];
    const phones = [await generateIdentity("mobile"), await generateIdentity("mobile"), await generateIdentity("mobile")];
    const bindings = [];
    for (const pc of pcs) for (const phone of phones) {
      const pair = await paired(pc, phone);
      expect((await post(`/v1/pairings/${pair.pairingId}/confirm`, { grant: pair.grantJws }, pc.token)).status).toBe(201);
      bindings.push(pair);
    }
    const token = await login(phones[0]);
    await SELF.fetch(origin + `/v1/bindings/${bindings[0].grant.bindingId}`, { method: "DELETE", headers: privateHeaders(token) });
    expect((await SELF.fetch(origin + `/v1/pcs/${pcs[0].pc.deviceId}/events`, { headers: privateHeaders(token) })).status).toBe(403);
    expect((await SELF.fetch(origin + `/v1/pcs/${pcs[1].pc.deviceId}/events`, { headers: privateHeaders(token) })).status).toBe(200);
    const other = await login(phones[1]);
    expect((await SELF.fetch(origin + `/v1/pcs/${pcs[0].pc.deviceId}/events`, { headers: privateHeaders(other) })).status).toBe(200);
  });
  it("forwards a decision once per id, detects ciphertext conflict and rechecks a revoked WSS", async () => {
    const pair = await paired(); await post(`/v1/pairings/${pair.pairingId}/confirm`, { grant: pair.grantJws }, pair.token);
    const token = await login(pair.mobile);
    const response = await SELF.fetch(origin + `/v1/pcs/${pair.pc.deviceId}/stream`, { headers: { ...privateHeaders(pair.token), upgrade: "websocket" } });
    expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept();
    const received: Record<string, unknown>[] = []; socket.addEventListener("message", event => { received.push(JSON.parse(String(event.data))); });
    const decisionId = crypto.randomUUID(); const payload = { decisionId, envelope: "synthetic.compact.ciphertext.with.tag" };
    try {
      expect((await post(`/v1/pcs/${pair.pc.deviceId}/decisions`, payload, token)).status).toBe(202);
      expect((await post(`/v1/pcs/${pair.pc.deviceId}/decisions`, { ...payload, envelope: "different.ciphertext" }, token)).status).toBe(409);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(received.some(value => value.type === "decision.submit" && value.decisionId === decisionId)).toBe(true);
      socket.send(JSON.stringify({ type: "decision.result", decisionId, mobileId: pair.mobile.deviceId, envelope: "signed.encrypted.desktop.receipt" }));
      await new Promise(resolve => setTimeout(resolve, 20));
      const repeated = await (await post(`/v1/pcs/${pair.pc.deviceId}/decisions`, payload, token)).json<{ state: string; envelope: string }>();
      expect(repeated.state).toBe("desktop_result");
      expect(repeated.envelope).toBe("signed.encrypted.desktop.receipt");
      await SELF.fetch(origin + "/v1/auth/session", { method: "DELETE", headers: privateHeaders(pair.token) });
      socket.send('{"type":"ping"}'); await new Promise(resolve => setTimeout(resolve, 20));
      expect(received.some(value => value.type === "error" && value.error === "unauthorized")).toBe(true);
    } finally { socket.close(); }
  });
  it("encrypts push tokens and sends only short visible notifications with bounded retry states", async () => {
    const pair = await paired(); await post(`/v1/pairings/${pair.pairingId}/confirm`, { grant: pair.grantJws }, pair.token);
    const key = await generateKeyPair("RS256", { extractable: true });
    const pushEnv = { ...env, FCM_ENABLED: "true", FCM_PROJECT_ID: "synthetic-project", FCM_CLIENT_EMAIL: "synthetic@example.invalid", FCM_PRIVATE_KEY: await exportPKCS8(key.privateKey) } as unknown as Env;
    const token = "synthetic-fcm-registration-token";
    const ciphertext = await encryptToken(token, pair.mobile.deviceId, pushEnv);
    expect(ciphertext).not.toContain(token);
    await env.DB.prepare("INSERT INTO push_tokens(device_id,ciphertext,revision,updated_at,active) VALUES(?,?,1,?,1)").bind(pair.mobile.deviceId, ciphertext, Date.now()).run();
    let status = 200; const messages: Record<string, any>[] = [];
    const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com")) return Response.json({ access_token: "synthetic-oauth-token", expires_in: 3600 });
      messages.push(JSON.parse(String(init?.body)));
      return status === 200 ? Response.json({ name: "synthetic-message" }) : Response.json({ error: { details: [{ errorCode: "UNREGISTERED" }] } }, { status });
    });
    try {
      const summary = { pcSessionEpoch: crypto.randomUUID(), eventId: crypto.randomUUID(), eventRevision: 1, kind: "approval", expiresAt: new Date(Date.now() + 120000).toISOString() };
      expect(await deliverPush(pushEnv, pair.pc.deviceId, pair.mobile.deviceId, summary)).toBe("sent");
      expect(messages[0].message.notification).toBeDefined();
      expect(Object.keys(messages[0].message.data).sort()).toEqual(["eventId", "eventRevision", "kind", "pcId", "pcSessionEpoch", "protocolVersion"]);
      expect(messages[0].message.android.notification.channel_id).toBe("approvals");
      expect(messages[0].message.notification.title).toBe("需要审批");
      const mobileToken = await login(pair.mobile);
      const preferencesUrl = origin + `/v1/pcs/${pair.pc.deviceId}/notification-preferences`;
      const prefs = { enabled: true, approvals: true, questions: true, completions: true, revision: Date.now(), locale: "en-US" };
      expect((await SELF.fetch(preferencesUrl, { method: "PUT", headers: privateHeaders(mobileToken), body: JSON.stringify(prefs) })).status).toBe(200);
      expect((await SELF.fetch(preferencesUrl, { method: "PUT", headers: privateHeaders(mobileToken), body: JSON.stringify({ ...prefs, locale: ["en-US"] }) })).status).toBe(400);
      expect(await deliverPush(pushEnv, pair.pc.deviceId, pair.mobile.deviceId, { ...summary, kind: "input" })).toBe("sent");
      expect(messages.at(-1)!.message.notification).toEqual({ title: "Choice or answer needed", body: "Return to the original app on your computer to respond." });
      for (const kind of ["approval", "question", "input", "plan", "completion"]) {
        expect(JSON.stringify(notificationCopy(kind, "en-US"))).not.toMatch(/[\u4e00-\u9fff]/);
        expect(notificationCopy(kind, "zh-CN").title).toMatch(/[\u4e00-\u9fff]/);
      }
      expect(JSON.stringify(messages[0]).length).toBeLessThan(2048);
      status = 503; expect(await deliverPush(pushEnv, pair.pc.deviceId, pair.mobile.deviceId, summary)).toBe("retry");
      status = 429; expect(await deliverPush(pushEnv, pair.pc.deviceId, pair.mobile.deviceId, summary)).toBe("retry");
      status = 404; expect(await deliverPush(pushEnv, pair.pc.deviceId, pair.mobile.deviceId, summary)).toBe("skip");
      expect((await env.DB.prepare("SELECT active FROM push_tokens WHERE device_id=?").bind(pair.mobile.deviceId).first<{ active: number }>())?.active).toBe(0);
    } finally { mocked.mockRestore(); }
  });
  it("enforces the configured active-PC cap and bounded unauthenticated bodies", async () => {
    const capacity = Number(env.MAX_PCS);
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE kind='pc' AND status='active'").first<{ n: number }>())!.n;
    for (let n = count; n < capacity - 1; n++) await enrolled();
    await env.DB.prepare("DELETE FROM rate_limits").run();
    const pc = await generateIdentity("pc"), device = await publicDevice(pc);
    const input = { device, proof: await sign({ protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), registrationId: crypto.randomUUID(), device }, pc.signKey, "enrollment") };
    const other = await generateIdentity("pc"), otherDevice = await publicDevice(other);
    const otherInput = { device: otherDevice, proof: await sign({ protocolVersion: 1, relayOrigin: origin, issuedAt: Date.now(), registrationId: crypto.randomUUID(), device: otherDevice }, other.signKey, "enrollment") };
    const attempts = await Promise.all([post("/v1/enrollments", input), post("/v1/enrollments", otherInput)]);
    expect(attempts.map(value => value.status).sort()).toEqual([201, 503]);
    const winner = attempts[0].status === 201 ? input : otherInput;
    expect((await post("/v1/enrollments", winner)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE kind='pc' AND status='active'").first<{ n: number }>())!.n).toBe(capacity);
    expect((await post("/v1/enrollments", { blob: "x".repeat(17000) })).status).toBe(413);
  });

});
