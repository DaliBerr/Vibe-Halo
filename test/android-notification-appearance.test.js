"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { AGENTS } = require("../src/agent-registry");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const clients = JSON.parse(read("apps/android/artwork/notification-clients.json"));
const appearance = read("apps/android/app/src/main/java/com/vibe/halo/mobile/notifications/NotificationAppearance.kt");
const names = read("apps/android/app/src/main/java/com/vibe/halo/mobile/notifications/NotificationPreview.kt");

test("Android notification branding covers every registered client with its canonical preview name and native icon", () => {
  assert.deepEqual(clients.map(client => client.id).sort(), AGENTS.map(agent => agent.id).sort());
  const mapped = [...appearance.matchAll(/"([a-z0-9-]+)" to Brand\(R\.color\.([a-z0-9_]+), R\.drawable\.([a-z0-9_]+)\)/g)];
  assert.deepEqual(mapped.map(match => match[1]).sort(), AGENTS.map(agent => agent.id).sort());
  for (const client of clients) {
    const agent = AGENTS.find(agent => agent.id === client.id);
    assert.equal(client.name, agent.name);
    assert.ok(names.includes(`"${client.id}" -> "${agent.name}"`));
    const mapping = mapped.find(match => match[1] === client.id);
    assert.equal(mapping[2], client.resource); assert.equal(mapping[3], client.resource);
    const icon = read(`apps/android/app/src/main/res/drawable/${client.resource}.xml`);
    assert.ok(icon.includes("android:pathData="));
    assert.ok(icon.includes(`android:fillColor="@color/${client.resource}"`));
    assert.match(client.sourceSha256, /^[0-9a-f]{64}$/);
  }
});

test("Android palettes retain the approved Codex/Claude colors and match every other client's shared palette", () => {
  const colors = folder => new Map([...read(`apps/android/app/src/main/res/${folder}/notification_colors.xml`)
    .matchAll(/<color name="([a-z0-9_]+)">(#[0-9A-Fa-f]{6})<\/color>/g)].map(match => [match[1], match[2]]));
  const light = colors("values"), dark = colors("values-night");
  assert.equal(light.size, AGENTS.length); assert.equal(dark.size, AGENTS.length);
  const original = { codex: ["#087F82", "#5AD9CC"], "claude-code": ["#B85C2F", "#FFAD82"] };
  for (const client of clients) {
    const agent = AGENTS.find(agent => agent.id === client.id);
    const expected = original[client.id] || [agent.appearance.accent, agent.appearance.inkDark];
    assert.equal(client.light, expected[0]); assert.equal(client.dark, expected[1]);
    assert.equal(light.get(client.resource), expected[0]); assert.equal(dark.get(client.resource), expected[1]);
  }
});
