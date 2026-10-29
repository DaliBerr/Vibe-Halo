"use strict";
const fs = require("node:fs");
const readline = require("node:readline");

function parseTiming(line) {
  if (typeof line !== "string" || line.length > 262144) return [];
  const start = line.indexOf('{');
  if (start >= 0) {
    try {
      const row = JSON.parse(line.slice(start));
      if (row.code !== "notification_timing") throw new Error("envelope");
      if (!["desktop", "relay", "android"].includes(row.host) || !Number.isFinite(row.atMs)
        || typeof row.eventId !== "string" || !/^[A-Za-z0-9_.:-]{1,240}$/.test(row.eventId)
        || typeof row.stage !== "string" || !/^[a-z_]{1,40}$/.test(row.stage)) return [];
      const safe = { host: row.host, stage: row.stage, eventId: row.eventId, atMs: row.atMs };
      for (const key of ["revision", "elapsedMs", "sourceAtMs", "detectedAtMs"]) if (Number.isFinite(row[key])) safe[key] = row[key];
      if (["fcm", "lan", "unknown"].includes(row.transport)) safe.transport = row.transport;
      return [safe];
    } catch { /* A Wrangler JSON envelope can contain escaped console messages. */ }
  }
  try {
    const envelope = JSON.parse(line);
    return (Array.isArray(envelope.logs) ? envelope.logs : []).slice(0, 100)
      .flatMap(log => (Array.isArray(log.message) ? log.message : []).slice(0, 10)
        .flatMap(message => typeof message === "string" && message.startsWith('{"code":"notification_timing"') ? parseTiming(message) : []));
  } catch { return []; }
}

function report(rows) {
  const events = new Map();
  for (const row of rows.slice(-20000)) {
    if (!events.has(row.eventId)) events.set(row.eventId, []);
    events.get(row.eventId).push(row);
  }
  return { warning: "Cross-host wall clocks are not synchronized. atMs is a correlation hint, not network latency. elapsedMs measures a local operation. notify_returned is OS submission, not visual display or watch arrival.",
    events: [...events].map(([eventId, stages]) => ({ eventId, stages })) };
}

async function main(files) {
  if (!files.length) throw new Error("Usage: node scripts/analyze-notification-timing.js <desktop.log> [relay.jsonl] [android.log]");
  const rows = [];
  for (const file of files) {
    let envelope = "";
    for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
      // Wrangler's JSON output may pretty-print each invocation across lines.
      if (envelope || line.trim() === "{") {
        envelope += line + "\n";
        if (envelope.length > 262144) { envelope = ""; continue; }
        try { JSON.parse(envelope); } catch { continue; }
        rows.push(...parseTiming(envelope)); envelope = "";
      } else rows.push(...parseTiming(line));
      if (rows.length > 20000) rows.splice(0, rows.length - 20000);
    }
  }
  process.stdout.write(JSON.stringify(report(rows), null, 2) + "\n");
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseTiming, report };
