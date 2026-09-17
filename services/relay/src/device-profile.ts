import { checkedProfile } from "../../../packages/protocol/src/device-profile.mjs";
import { body, record, signed, response, Fault, rate, type Session } from "./common";

export async function updateProfile(request: Request, env: Env, session: Session): Promise<Response> {
  await rate(request, env, "device-profile", 120);
  const input = record(await body(request, 4096), ["profile"]);
  const value = await signed(input.profile, session.device.signKey, "device-profile");
  try { checkedProfile(value, session.device.deviceId, env.RELAY_ORIGIN); } catch { throw new Fault("invalid_profile"); }
  await env.DB.prepare("INSERT INTO device_profiles(device_id,revision,profile_jws) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,profile_jws=excluded.profile_jws WHERE excluded.revision>device_profiles.revision")
    .bind(session.device.deviceId, value.revision, input.profile).run();
  const stored = await env.DB.prepare("SELECT revision,profile_jws FROM device_profiles WHERE device_id=?").bind(session.device.deviceId).first<{revision:number;profile_jws:string}>();
  // ECDSA can produce a different signature for an identical retry.
  const previous = await signed(stored!.profile_jws, session.device.signKey, "device-profile");
  if (stored!.revision !== value.revision || previous.name !== value.name) throw new Fault("profile_conflict", 409);
  const pcs = session.device.kind === "pc" ? [session.device.deviceId] : (await env.DB.prepare("SELECT pc_id FROM bindings WHERE mobile_id=? AND state='active' LIMIT 64").bind(session.device.deviceId).all<{pc_id:string}>()).results.map(row => row.pc_id);
  for (const pcId of pcs) await env.RELAY.getByName(pcId).profilesChanged();
  return response({ revision: value.revision });
}
