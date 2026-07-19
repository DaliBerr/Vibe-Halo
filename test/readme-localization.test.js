"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const english = fs.readFileSync(path.join(root, "README.md"), "utf8");
const chinese = fs.readFileSync(path.join(root, "README.zh-CN.md"), "utf8");

test("English README uses real English tray labels and links the Chinese edition", () => {
  assert.match(english, /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(english, /\*\*Client integrations\*\*/);
  assert.match(english, /\*\*Language\*\*/);
  assert.doesNotMatch(english, /`(?:客户端集成|启用审批|等待输入提醒|开机启动|诊断信息)`/);
});

test("both READMEs document live language switching and the bilingual installer", () => {
  assert.match(english, /automatically follows the Windows display language/);
  assert.match(english, /switch immediately without restarting/);
  assert.match(chinese, /自动跟随 Windows 显示语言/);
  assert.match(chinese, /即时切换，无需重启/);
});
