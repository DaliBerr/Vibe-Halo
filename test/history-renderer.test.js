"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..", "src", "history-renderer");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const javascript = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "..", "history-preload.js"), "utf8");

test("history renderer has four filters, client filter, list and read-only detail views", () => {
  for (const kind of ["all", "approval", "question", "plan"]) assert.match(html, new RegExp(`data-kind="${kind}"`));
  assert.match(html, /id="client-filter"/);
  assert.match(html, /id="event-list"[^>]+role="list"/);
  assert.match(html, /id="detail-view"/);
  assert.doesNotMatch(javascript, /approve|replay|submitAnswer|islandAPI/);
});

test("history renderer supports localization, dark and light surfaces, badges, and fade", () => {
  assert.match(javascript, /document\.documentElement\.lang = state\.locale === "zh-CN"/);
  assert.match(javascript, /document\.documentElement\.dataset\.theme/);
  assert.match(javascript, /applyAppearance\(card, item\.agentAppearance\)/);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /\.history-panel\.fading\s*\{[^}]*opacity:\s*0/s);
  assert.match(css, /\.event-list\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.event-title\s*\{[^}]*display:\s*block[^}]*text-overflow:\s*ellipsis/s);
  assert.match(javascript, /historyAPI\.pointer\(false\)/);
  assert.match(css, /body\s*\{[^}]*padding:\s*28px 40px 52px/s);
  assert.match(css, /\.panel-header\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(css, /\.panel-header button\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.doesNotMatch(css, /padding:\s*8px 8px 18px/);
});

test("copying is limited to main-process region ids", () => {
  assert.match(javascript, /historyAPI\.copy\(selectedId, options\.copySection\)/);
  assert.doesNotMatch(javascript, /clipboard|writeText/);
  assert.match(preload, /copy: \(id, section\) => ipcRenderer\.invoke\("history:copy", \{ id, section \}\)/);
  assert.doesNotMatch(preload, /filePath|writeText|rawResponse|token|authorization/i);
});
