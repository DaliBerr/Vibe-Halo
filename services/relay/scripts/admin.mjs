import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), action = args[0];
const local = args.includes("--local"), remote = args.includes("--remote");
if (local === remote || !["status", "open-registration", "close-registration", "revoke-pc"].includes(action)) {
  throw new Error("Usage: node scripts/admin.mjs status|open-registration|close-registration|revoke-pc --local|--remote [--pc <pc-id>] [--config <wrangler-file>]");
}
function argument(name) { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; }
const configFile = argument("--config");
if (args.includes("--config") && (!configFile || configFile.startsWith("--"))) throw new Error("--config requires a Wrangler configuration file.");
function execute(sql) {
  const directory = fs.mkdtempSync(path.join(root, ".wrangler", "admin-"));
  try {
    const file = path.join(directory, "operation.sql"); fs.writeFileSync(file, sql, { mode: 0o600 });
    return execFileSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "DB", local ? "--local" : "--remote", "--file", file, ...(configFile ? ["--config", path.resolve(configFile)] : [])], { cwd: root, stdio: "pipe", timeout: 60000 });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
fs.mkdirSync(path.join(root, ".wrangler"), { recursive: true });
if (action === "status") {
  console.log(execute("SELECT id,value FROM relay_settings; SELECT id,status,created_at FROM devices WHERE kind='pc' ORDER BY created_at DESC LIMIT 100;").toString());
} else if (action === "open-registration" || action === "close-registration") {
  const value = action === "open-registration" ? "open" : "closed";
  execute(`UPDATE relay_settings SET value='${value}' WHERE id='registration';`);
  console.log(`New PC registration is ${value}. Existing devices and pairing grants are unchanged.`);
} else {
  const pcId = argument("--pc"); if (!/^pc_[A-Za-z0-9-]{1,80}$/.test(pcId || "")) throw new Error("Invalid PC id.");
  execute(`UPDATE devices SET status='revoked' WHERE id='${pcId}' AND kind='pc';
UPDATE spaces SET status='revoked' WHERE pc_id='${pcId}';
UPDATE bindings SET state='revoked',revision=revision+1,pc_ack=0 WHERE pc_id='${pcId}' AND state='active';
DELETE FROM device_sessions WHERE device_id='${pcId}';`);
  console.log("PC cloud authority revoked. An offline PC must learn the revocation before its local trust can change.");
}
