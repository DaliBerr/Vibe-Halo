import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), action = args[0];
const local = args.includes("--local"), remote = args.includes("--remote");
if (local === remote || !["enrollment-code", "revoke-pc"].includes(action)) {
  throw new Error("Usage: node scripts/admin.mjs enrollment-code --local|--remote --out <private-file>; or revoke-pc --local|--remote --pc <pc-id>");
}
function argument(name) { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; }
function execute(sql) {
  const directory = fs.mkdtempSync(path.join(root, ".wrangler", "admin-"));
  try {
    const file = path.join(directory, "operation.sql"); fs.writeFileSync(file, sql, { mode: 0o600 });
    execFileSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "DB", local ? "--local" : "--remote", "--file", file], { cwd: root, stdio: "pipe", timeout: 60000 });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
fs.mkdirSync(path.join(root, ".wrangler"), { recursive: true });
if (action === "enrollment-code") {
  const output = argument("--out"); if (!output) throw new Error("A private output file is required; codes are never printed.");
  let pepper = process.env.ENROLLMENT_PEPPER;
  if (local && !pepper) {
    const line = fs.readFileSync(path.join(root, ".dev.vars"), "utf8").split(/\r?\n/).find(value => value.startsWith("ENROLLMENT_PEPPER="));
    pepper = line?.slice("ENROLLMENT_PEPPER=".length).replace(/^['"]|['"]$/g, "");
  }
  if (!pepper || pepper.length < 32) throw new Error("Set the enrollment HMAC pepper securely in the process environment.");
  const code = crypto.randomBytes(16).toString("hex").toUpperCase(), expiry = Date.now() + 30 * 60000;
  const destination = path.resolve(output);
  // Do not overwrite an existing private artifact or print the code in logs.
  const descriptor = fs.openSync(destination, "wx", 0o600);
  try {
    const hmac = crypto.createHmac("sha256", pepper).update(code).digest("hex");
    execute(`INSERT INTO enrollment_codes(code_hmac,expires_at) VALUES('${hmac}',${expiry});`);
    fs.writeFileSync(descriptor, `${code}\nExpires: ${new Date(expiry).toISOString()}\n`);
  } finally { fs.closeSync(descriptor); }
  console.log("One-time enrollment code written to the requested private file; expires in 30 minutes.");
} else {
  const pcId = argument("--pc"); if (!/^pc_[A-Za-z0-9-]{1,80}$/.test(pcId || "")) throw new Error("Invalid PC id.");
  execute(`UPDATE devices SET status='revoked' WHERE id='${pcId}' AND kind='pc';
UPDATE spaces SET status='revoked' WHERE pc_id='${pcId}';
UPDATE bindings SET state='revoked',revision=revision+1,pc_ack=0 WHERE pc_id='${pcId}' AND state='active';
DELETE FROM device_sessions WHERE device_id='${pcId}';`);
  console.log("PC cloud authority revoked. An offline PC must learn the revocation before its local trust can change.");
}
