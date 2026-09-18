"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const englishHome = fs.readFileSync(path.join(root, "README.md"), "utf8");
const english = englishHome + "\n" + fs.readFileSync(path.join(root, "docs/GUIDE.md"), "utf8");
const chineseHome = fs.readFileSync(path.join(root, "README.zh-CN.md"), "utf8");
const chinese = chineseHome + "\n" + fs.readFileSync(path.join(root, "docs/GUIDE.zh-CN.md"), "utf8");

test("English README uses real English tray labels and links the Chinese edition", () => {
  assert.match(english, /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(english, /\*\*Client integrations\*\*/);
  assert.match(english, /\*\*Language\*\*/);
  assert.doesNotMatch(english, /`(?:客户端集成|启用审批|等待输入提醒|开机启动|诊断信息)`/);
});

test("both documentation editions document live language switching and system locale selection", () => {
  assert.match(english, /follows the operating-system UI locale by default/);
  assert.match(english, /switch immediately without restarting/);
  assert.match(chinese, /默认跟随操作系统 UI 语言/);
  assert.match(chinese, /即时切换，无需重启/);
});

test("both documentation editions describe all preview platforms and honest validation boundaries", () => {
  for (const document of [english, chinese]) {
    assert.match(document, /Windows/);
    assert.match(document, /macOS/);
    assert.match(document, /Linux/);
    assert.match(document, /AppImage/);
    assert.match(document, /SHA-256/);
  }
  assert.match(english, /real client response round trips on those platforms remain unverified/);
  assert.match(chinese, /真实客户端回传尚未实机验证/);
});

test("both documentation editions document tray-only local history and sensitive storage", () => {
  assert.match(english, /Open \*\*Recent events\*\* from the tray/);
  assert.match(english, /Ordinary task-completion notifications are deliberately excluded/);
  assert.match(english, /safeStorage/);
  assert.match(english, /30 days/);
  assert.match(chinese, /从托盘打开“最近事件”/);
  assert.match(chinese, /普通任务完成通知明确不进入历史/);
  assert.match(chinese, /safeStorage/);
  assert.match(chinese, /30 天/);
});

test("concise home pages link their detailed guides", () => {
  assert.match(englishHome, /\]\(docs\/GUIDE\.md\)/);
  assert.match(chineseHome, /\]\(docs\/GUIDE\.zh-CN\.md\)/);
});
