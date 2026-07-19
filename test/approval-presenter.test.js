"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatApprovalInput } = require("../src/approval-presenter");
const { translate } = require("../src/i18n");

const zh = (key, params) => translate("zh-CN", key, params);

test("presents commands as the primary content without duplicating the description", () => {
  const view = formatApprovalInput({
    command: "Get-Date",
    cwd: "C:\\Tools\\Demo",
    description: "读取当前时间",
  }, "读取当前时间", zh);
  assert.equal(view.kind, "command");
  assert.equal(view.label, "命令");
  assert.equal(view.primary, "Get-Date");
  assert.equal(view.copyLabel, "复制命令");
  assert.equal(view.copyText, "Get-Date");
  assert.deepEqual(view.metadata, [{ label: "工作目录", value: "C:\\Tools\\Demo" }]);
  assert.equal(view.hasRaw, true);
  assert.match(view.raw, /"command": "Get-Date"/);
});

test("uses human-readable labels for patches, queries and paths in both locales", () => {
  assert.equal(formatApprovalInput({ patch: "*** Begin Patch" }).kind, "patch");
  assert.equal(formatApprovalInput({ query: "electron BrowserWindow" }).label, "Query");
  assert.equal(formatApprovalInput({ file_path: "C:\\demo.txt" }, "", zh).label, "路径");
  assert.equal(formatApprovalInput({ url: "https://example.com" }, "", zh).label, "网址");
});

test("keeps unknown structured arguments behind the raw-details fallback", () => {
  const view = formatApprovalInput({ nested: { enabled: true }, retries: 3 }, "", zh);
  assert.equal(view.kind, "structured");
  assert.match(view.primary, /查看完整参数/);
  assert.equal(view.copyText, view.raw);
  assert.match(view.raw, /"nested"/);
});

test("bounds renderer-facing primary and raw content", () => {
  const view = formatApprovalInput({ command: "x".repeat(20_000), extra: "y".repeat(20_000) });
  assert.equal(view.primary.length, 10_000);
  assert.ok(view.raw.length <= 10_000);
  assert.ok(view.copyText.length <= 10_000);
});
