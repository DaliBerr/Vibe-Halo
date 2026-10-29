// Explicit scalar fields only: no device identity, push token, preview or errors.
export function notificationTiming(stage: string, eventId: unknown, revision: unknown, elapsedMs?: number) {
  try {
    if (typeof eventId !== "string" || !/^[a-zA-Z0-9_.:-]{1,240}$/.test(eventId)) return;
    console.log(JSON.stringify({ code: "notification_timing", host: "relay", stage, eventId,
      revision: Number.isSafeInteger(revision) ? revision : 0, atMs: Date.now(),
      ...(Number.isFinite(elapsedMs) && Number(elapsedMs) >= 0 ? { elapsedMs } : {}) }));
  } catch { /* Logging must not affect push delivery. */ }
}
