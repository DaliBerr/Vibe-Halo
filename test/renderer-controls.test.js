"use strict";

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const rendererRoot = path.resolve(__dirname, "..", "src", "renderer");
const html = fs.readFileSync(path.join(rendererRoot, "index.html"), "utf8");
const css = fs.readFileSync(path.join(rendererRoot, "style.css"), "utf8");
const javascript = fs.readFileSync(path.join(rendererRoot, "renderer.js"), "utf8");

test("expanded island exposes a centered non-destructive collapse control", () => {
  assert.match(html, /id="collapse"[^>]+aria-label="Collapse island"/);
  assert.match(css, /\.collapse-button\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*transform:\s*translateX\(-50%\)/s);
  assert.match(css, /\.collapse-button\s*\{[^}]*border-radius:\s*999px[^}]*background:\s*#08090b[^}]*box-shadow:/s);
  assert.match(javascript, /collapseButton\.addEventListener\("click"[\s\S]+islandAPI\.view\(state\.current\.id, "collapse"\)/);
  assert.match(javascript, /document\.documentElement\.lang = state\?\.locale === "zh-CN"/);
  assert.match(javascript, /collapseButton\.setAttribute\("aria-label", ui\("collapseIsland"\)\)/);
});

test("compact expand indicator uses a fixed SVG box instead of a font glyph", () => {
  assert.match(html, /class="compact-chevron"[\s\S]+class="chevron-icon"[\s\S]+<path d="M3\.5 5\.75 8 10\.25l4\.5-4\.5">/);
  assert.doesNotMatch(html, />\s*⌄\s*</);
  assert.match(css, /\.compact-chevron\s*\{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*place-items:\s*center/s);
});

test("client identity uses a labeled compact chip and matching expanded badge", () => {
  assert.match(html, /id="compact-agent" class="agent-chip">Codex<\/span>/);
  assert.match(html, /id="agent-badge" class="agent-badge"[^>]*>C<\/span>/);
  assert.match(css, /\.agent-chip\s*\{[^}]*--agent-accent|\.agent-chip\s*\{[^}]*color-mix\([^)]*var\(--agent-accent\)/s);
  assert.match(css, /\.agent-badge\s*\{[^}]*color-mix\([^)]*var\(--agent-accent\)/s);
  assert.match(javascript, /function applyAgentAppearance\(item, agentName\)/);
  assert.match(javascript, /compactAgent\.textContent = agentName/);
  assert.match(javascript, /agentBadge\.textContent = glyph/);
});

test("Codex plan completions use a dedicated compact summary", () => {
  assert.match(javascript, /item\.completionKind === "plan" \? "planReadySummary" : "completedSummary"/);
  assert.match(javascript, /planReadySummary: "Plan ready"/);
});
