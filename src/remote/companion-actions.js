"use strict";

const { safeTree } = require("../../packages/protocol");

const COMPANION_ACTIONS = Object.freeze([
  "status", "rename", "configure", "enable", "disable", "control", "pair",
  "cancel-pair", "test-notification", "poll", "confirm", "revoke",
]);
const COMPANION_ERRORS = Object.freeze([
  "secure_storage_unavailable", "credential_store_invalid", "remote_journal_invalid", "invalid_code",
  "invalid_relay_origin", "remove_existing_identity_first", "capacity_exceeded", "pairing_expired",
  "invalid_claim", "invalid_scopes", "service_unconfigured", "invalid_device_name",
]);
const MAX_COMPANION_INPUT_BYTES = 16384;

function validCompanionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !safeTree(input)) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_COMPANION_INPUT_BYTES) return false;
  } catch {
    return false;
  }
  return COMPANION_ACTIONS.includes(input.action);
}

/** Runs one phone-companion action against RemoteService and returns its snapshot or a bounded error code. */
async function performCompanionAction(remote, input) {
  if (!remote || !validCompanionInput(input)) return { error: "invalid_request" };
  try {
    switch (input.action) {
      case "status": return remote.snapshot();
      case "rename": return await remote.rename(input.name, input.reset === true);
      case "configure": return await remote.connectDefault();
      case "enable": await remote.start(); return remote.snapshot();
      case "disable": await remote.stop(true); return remote.snapshot();
      case "control": return remote.setControl(input.enabled);
      case "pair": return await remote.beginPairing(input.scopes);
      case "cancel-pair": return await remote.cancelPairing();
      case "test-notification": return remote.testNotification();
      case "poll": return await remote.pollPairing();
      case "confirm": return await remote.confirmPairing(input.fingerprint);
      case "revoke": return await remote.revoke(input.bindingId);
      default: return { error: "invalid_request" };
    }
  } catch (error) {
    return { error: COMPANION_ERRORS.includes(error.message) ? error.message : "operation_failed" };
  }
}

module.exports = { COMPANION_ACTIONS, COMPANION_ERRORS, performCompanionAction, validCompanionInput };
