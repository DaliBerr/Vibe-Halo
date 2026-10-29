"use strict";

// Diagnostic metadata only; never accept arbitrary payload fields or exception text.
function notificationTiming(logger, stage, eventId, revision = 1, metrics = {}) {
  try {
    if (typeof stage !== "string" || typeof eventId !== "string" || !Number.isSafeInteger(revision)
      || !/^[a-z_]{1,40}$/.test(stage) || !/^[a-zA-Z0-9_.:-]{1,240}$/.test(eventId)) return;
    const value = { code: "notification_timing", host: "desktop", stage, eventId, revision, atMs: Date.now() };
    for (const key of ["sourceAtMs", "detectedAtMs", "elapsedMs"]) {
      if (Number.isFinite(metrics[key]) && metrics[key] >= 0) value[key] = metrics[key];
    }
    logger?.info("notification_timing", value);
  } catch { /* Diagnostics cannot interrupt delivery. */ }
}

module.exports = { notificationTiming };
