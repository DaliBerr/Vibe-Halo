export function deviceName(value) {
  if (typeof value !== "string") throw new Error("invalid_device_name");
  const name = value.trim();
  if (!name || [...name].length > 48 || /[\p{Cc}\p{Cf}]/u.test(name.replace(/\u200d/g, ""))) throw new Error("invalid_device_name");
  return name;
}

export function checkedProfile(value, deviceId, origin) {
  if (!value || Object.keys(value).some(key => !["protocolVersion", "deviceId", "relayOrigin", "revision", "name"].includes(key))
    || value.protocolVersion !== 1 || value.deviceId !== deviceId || value.relayOrigin !== origin
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || deviceName(value.name) !== value.name) throw new Error("invalid_profile");
  return value;
}
