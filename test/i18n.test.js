"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRequest } = require("../src/agent-registry");
const { ApprovalStore } = require("../src/approval-store");
const { CompletionStore } = require("../src/completion-store");
const { createLocalizer, catalogDifferences, interpolate, resolveLocale, systemLocaleToSupported } = require("../src/i18n");
const { InputRequestStore } = require("../src/input-request-store");
const { IslandController } = require("../src/island-controller");

function controllerFixture(
  localization,
  approvals = new ApprovalStore(),
  inputRequests = new InputRequestStore(),
  completions = new CompletionStore(),
) {
  return new IslandController({
    BrowserWindow: function BrowserWindow() {},
    screen: {},
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {},
    clipboard: {},
    approvalStore: approvals,
    inputRequestStore: inputRequests,
    completionStore: completions,
    localization,
  });
}

test("resolves supported Windows locales and rejects unsupported preferences", () => {
  assert.equal(systemLocaleToSupported("zh-CN"), "zh-CN");
  assert.equal(systemLocaleToSupported("zh_Hans_SG"), "zh-CN");
  assert.equal(systemLocaleToSupported("zh-TW"), "en-US");
  assert.equal(systemLocaleToSupported("fr-FR"), "en-US");
  assert.equal(resolveLocale("zh-CN", "en-US"), "zh-CN");
  assert.equal(resolveLocale("invalid", "zh-CN"), "zh-CN");
});

test("catalogs have identical keys and interpolation preserves unknown placeholders", () => {
  assert.deepEqual(catalogDifferences(), { missingEnglish: [], missingChinese: [] });
  assert.equal(interpolate("{agent} {count} {missing}", { agent: "Codex", count: 2 }), "Codex 2 {missing}");
});

test("language switching retranslates queued Vibe Halo chrome without changing protocol data", () => {
  const approvals = new ApprovalStore({ timeoutMs: 60_000 });
  const request = normalizeRequest("zcode", {
    event: "PermissionRequest",
    session_id: "s1",
    request_id: "r1",
    tool_name: "Bash",
    tool_input: { command: "npm test", description: "客户端原文" },
    description: "客户端原文",
  });
  approvals.enqueue(request, { complete() {} });
  const localization = createLocalizer({ preference: "en-US", systemLocale: "zh-CN" });
  const controller = controllerFixture(localization, approvals);

  const english = controller.state();
  assert.equal(english.locale, "en-US");
  assert.deepEqual(english.current.options.map(option => option.label), ["Allow once", "Deny", "Handle in client"]);
  assert.equal(english.current.description, "客户端原文");
  assert.equal(english.current.presentation.primary, "npm test");
  assert.deepEqual(english.current.agentAppearance, {
    glyph: "Z", accent: "#6D5EF7", inkLight: "#5145CD", inkDark: "#B9B3FF",
  });

  localization.setPreference("zh-CN");
  const chinese = controller.state();
  assert.equal(chinese.current.id, english.current.id);
  assert.deepEqual(chinese.current.options.map(option => option.label), ["允许一次", "拒绝", "在客户端处理"]);
  assert.equal(chinese.current.description, "客户端原文");
  assert.equal(chinese.current.presentation.primary, "npm test");
  assert.equal(Object.hasOwn(chinese.current.options[0], "labelKey"), false);
});

test("renderer strings are bounded to the active locale", () => {
  const localization = createLocalizer({ preference: "system", systemLocale: "zh-CN" });
  const chinese = localization.rendererStrings();
  assert.equal(chinese.copyContent, "复制内容");
  assert.equal(chinese.waitingChoiceSummary, "等待你的选择");
  assert.equal(chinese.completedSummary, "已完成");
  assert.equal(chinese.planReadySummary, "计划已就绪");
  assert.equal(Object.keys(chinese).length, 26);
  localization.setPreference("en-US");
  assert.equal(localization.rendererStrings().copyContent, "Copy content");
});

test("client-provided questions, options, titles, and outputs remain unchanged", () => {
  const localization = createLocalizer({ preference: "en-US", systemLocale: "zh-CN" });
  const inputRequests = new InputRequestStore();
  const completions = new CompletionStore();
  const controller = controllerFixture(localization, new ApprovalStore(), inputRequests, completions);
  inputRequests.enqueue({
    agentId: "zcode",
    agentName: "ZCode",
    requestKey: "zcode:s1:q1",
    title: "客户端标题",
    questions: [{ id: "q1", question: "请选择？", options: [{ label: "原始选项", description: "原始说明" }] }],
  });
  let state = controller.state();
  assert.equal(state.current.title, "客户端标题");
  assert.equal(state.current.questions[0].question, "请选择？");
  assert.equal(state.current.questions[0].options[0].label, "原始选项");
  inputRequests.clear();
  completions.show({ agentId: "zcode", agentName: "ZCode", title: "完成标题", output: "客户端输出" });
  state = controller.state();
  assert.equal(state.current.title, "完成标题");
  assert.equal(state.current.output, "客户端输出");
});

test("plan-ready completions retranslate without changing their semantic kind", () => {
  const localization = createLocalizer({ preference: "en-US", systemLocale: "en-US" });
  const completions = new CompletionStore();
  const controller = controllerFixture(localization, new ApprovalStore(), new InputRequestStore(), completions);
  completions.show({
    agentId: "codex",
    agentName: "Codex",
    completionKind: "plan",
    titleKey: "fallback.planReadyTitle",
    outputKey: "fallback.planReadyContent",
  });
  let state = controller.state();
  assert.equal(state.current.completionKind, "plan");
  assert.equal(state.current.title, "Codex plan is ready");
  assert.equal(state.current.output, "Review the completed plan in Codex.");
  localization.setPreference("zh-CN");
  state = controller.state();
  assert.equal(state.current.completionKind, "plan");
  assert.equal(state.current.title, "Codex 计划已就绪");
  assert.equal(state.current.output, "请回到 Codex 查看已完成的计划。");
});
