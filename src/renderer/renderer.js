"use strict";

const island = document.getElementById("island");
const compact = document.getElementById("compact");
const expanded = document.getElementById("expanded");
const compactTitle = document.getElementById("compact-title");
const count = document.getElementById("count");
const title = document.getElementById("title");
const subtitle = document.getElementById("subtitle");
const description = document.getElementById("description");
const contentPanel = document.getElementById("content-panel");
const primaryLabel = document.getElementById("primary-label");
const primaryCode = document.getElementById("primary-code");
const primaryProse = document.getElementById("primary-prose");
const questionList = document.getElementById("question-list");
const metadata = document.getElementById("metadata");
const rawDetails = document.getElementById("raw-details");
const rawContent = document.getElementById("raw-content");
const closeButton = document.getElementById("close");
const copyButton = document.getElementById("copy");
const actions = document.getElementById("actions");
const overflowActions = document.getElementById("overflow-actions");
const overflowToggle = document.getElementById("overflow-toggle");
const overflowMenu = document.getElementById("overflow-menu");

const canvas = document.createElement("canvas");
const context = canvas.getContext("2d");
let state = null;
let copyText = "";
let lastItemId = null;
let measurementFrame = null;
let lastMeasurement = "";

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function renderMetadata(items) {
  clearElement(metadata);
  const values = Array.isArray(items) ? items : [];
  metadata.hidden = values.length === 0;
  for (const item of values) {
    const term = document.createElement("dt");
    term.textContent = item.label || "参数";
    const detail = document.createElement("dd");
    detail.textContent = item.value || "";
    metadata.append(term, detail);
  }
}

function renderQuestions(questions, interactive = false, item = null) {
  clearElement(questionList);
  const values = Array.isArray(questions) ? questions : [];
  questionList.hidden = values.length === 0;
  for (const question of values) {
    const card = document.createElement("article");
    card.className = "question-card";
    if (question.header) {
      const header = document.createElement("div");
      header.className = "question-header";
      header.textContent = question.header;
      card.appendChild(header);
    }
    const text = document.createElement("div");
    text.className = "question-text";
    text.textContent = question.question || "Codex 正在等待你的输入。";
    card.appendChild(text);
    if (Array.isArray(question.options) && question.options.length) {
      const options = document.createElement("div");
      options.className = "option-list";
      for (const option of question.options) {
        const row = document.createElement(interactive ? "label" : "div");
        row.className = interactive ? "option-row option-input-row" : "option-row";
        if (interactive) {
          const input = document.createElement("input");
          input.type = question.multiSelect ? "checkbox" : "radio";
          input.name = `question-${question.id}`;
          input.value = option.id;
          input.dataset.questionId = question.id;
          input.addEventListener("change", () => {
            if (!input.checked || !state?.current || state.current.id !== item?.id) return;
            const decision = window.vibeQuestionSubmit?.zcodeSingleChoiceDecision(item, values, question, option);
            if (decision) window.islandAPI.decide(decision.approvalId, decision.optionId, decision.answers);
          });
          row.appendChild(input);
        }
        const copy = document.createElement("div");
        const label = document.createElement("div");
        label.className = "option-label";
        label.textContent = option.label || "选项";
        copy.appendChild(label);
        if (option.description) {
          const detail = document.createElement("div");
          detail.className = "option-description";
          detail.textContent = option.description;
          copy.appendChild(detail);
        }
        row.appendChild(copy);
        options.appendChild(row);
      }
      card.appendChild(options);
    }
    if (interactive && question.allowText) {
      const textarea = document.createElement("textarea");
      textarea.className = "answer-text";
      textarea.dataset.questionId = question.id;
      textarea.maxLength = 2000;
      textarea.placeholder = question.options?.length ? "其他答案（可选）" : "输入回答";
      card.appendChild(textarea);
    }
    questionList.appendChild(card);
  }
}

function collectAnswers(questions) {
  const result = {};
  for (const question of Array.isArray(questions) ? questions : []) {
    const selected = [...questionList.querySelectorAll(`input[data-question-id="${CSS.escape(question.id)}"]:checked`)]
      .map(input => input.value).filter(Boolean);
    const textarea = questionList.querySelector(`textarea[data-question-id="${CSS.escape(question.id)}"]`);
    const text = textarea?.value.trim().slice(0, 2000) || "";
    if (text) selected.push(text);
    if (!selected.length) return null;
    result[question.id] = question.multiSelect ? selected.slice(0, 20) : selected[0];
  }
  return result;
}

function createActionButton(item, option) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = option.tone === "danger" ? "danger" : (option.tone === "primary" ? "primary" : "secondary");
  button.textContent = option.label;
  button.addEventListener("click", () => {
    if (!state?.current || state.current.id !== item.id) return;
    const answers = option.id === "submit" ? collectAnswers(item.questions) : undefined;
    if (option.id === "submit" && !answers) return;
    window.islandAPI.decide(item.id, option.id, answers);
  });
  return button;
}

function renderActions(item, actionable) {
  clearElement(actions);
  clearElement(overflowMenu);
  overflowMenu.hidden = true;
  const options = actionable && Array.isArray(item.options) ? item.options : [];
  const primary = [];
  const overflow = [];
  for (const option of options) {
    if (option.overflow || primary.length >= 3) overflow.push(option);
    else primary.push(option);
  }
  for (const option of primary) actions.appendChild(createActionButton(item, option));
  for (const option of overflow) overflowMenu.appendChild(createActionButton(item, option));
  overflowActions.hidden = overflow.length === 0;
}

function setPrimaryCode(label, text) {
  primaryLabel.textContent = label || "内容";
  primaryLabel.hidden = false;
  primaryCode.textContent = text || "";
  primaryCode.hidden = false;
  primaryProse.hidden = true;
}

function setPrimaryProse(text) {
  primaryLabel.hidden = true;
  primaryCode.hidden = true;
  primaryProse.textContent = text || "";
  primaryProse.hidden = false;
}

function measureLineWidth(text, element) {
  if (!context || !text) return 0;
  context.font = getComputedStyle(element).font;
  let maximum = 0;
  const lines = String(text).split(/\r?\n/).slice(0, 300);
  for (const line of lines) maximum = Math.max(maximum, context.measureText(line.slice(0, 600)).width);
  return maximum;
}

function desiredDimensions() {
  const item = state?.current;
  const isApproval = item?.type === "approval";
  const widthSource = isApproval ? item.presentation?.primary : "";
  const lineWidth = measureLineWidth(widthSource, primaryCode);
  const width = Math.max(668, Math.min(808, Math.ceil(lineWidth + 182)));
  const visibleRows = [expanded.querySelector("header"), description.hidden ? null : description, contentPanel, expanded.querySelector("footer")].filter(Boolean);
  const fixedHeight = visibleRows
    .filter(element => element !== contentPanel)
    .reduce((total, element) => total + element.offsetHeight, 0);
  const gaps = Math.max(0, visibleRows.length - 1) * 18;
  const naturalPanelHeight = Math.max(180, Math.min(360, contentPanel.scrollHeight));
  const height = Math.max(516, Math.min(636, Math.ceil(36 + 48 + fixedHeight + gaps + naturalPanelHeight)));
  return { width, height };
}

function scheduleMeasurement() {
  if (!state?.current || !state.mode.endsWith("expanded")) return;
  if (measurementFrame) cancelAnimationFrame(measurementFrame);
  measurementFrame = requestAnimationFrame(() => {
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = null;
      const dimensions = desiredDimensions();
      const key = `${state.current.id}:${dimensions.width}:${dimensions.height}`;
      if (key === lastMeasurement) return;
      lastMeasurement = key;
      window.islandAPI.view(state.current.id, "measure", dimensions.width, dimensions.height);
    });
  });
}

function render(next) {
  if (!next || !next.current || next.mode === "hidden") return;
  state = next;
  document.documentElement.dataset.theme = next.theme === "light" ? "light" : "dark";
  const item = next.current;
  const isApproval = item.type === "approval";
  const isElicitation = item.type === "elicitation";
  const isActionable = isApproval || isElicitation;
  const isInputRequest = item.type === "input-request";
  const isExpanded = next.mode.endsWith("expanded");
  const kind = isActionable ? (isElicitation ? "elicitation" : "approval") : (isInputRequest ? "input-request" : "completion");
  island.className = `island ${isExpanded ? "expanded" : "compact"} ${kind}`;
  compact.hidden = isExpanded;
  expanded.hidden = !isExpanded;
  const agentName = item.agentName || "Codex";
  compactTitle.textContent = isActionable
    ? `${agentName} · ${isElicitation ? "等待回答" : `${item.toolName} 请求审批`}`
    : (isInputRequest ? `${agentName} 等待你的选择` : `${agentName} 已完成`);
  count.hidden = (!isActionable && !isInputRequest) || next.pendingCount <= 1;
  count.textContent = String(next.pendingCount);
  title.textContent = isActionable
    ? (isElicitation ? `${agentName} 等待你的回答` : `${agentName} · ${item.toolName}`)
    : (item.title || (isInputRequest ? `${agentName} 等待你的选择` : `${agentName} 已完成`));
  subtitle.textContent = item.cwd || item.sessionId || agentName;
  const explanation = isInputRequest ? `请回到 ${agentName} 原生界面完成选择。` : (isActionable ? item.description : "");
  description.hidden = !explanation;
  description.textContent = explanation;

  if (item.id !== lastItemId) {
    rawDetails.open = false;
    lastItemId = item.id;
    lastMeasurement = "";
  }

  if (isApproval) {
    const presentation = item.presentation || {};
    setPrimaryCode(presentation.label, presentation.primary);
    renderMetadata(presentation.metadata);
    renderQuestions([]);
    rawDetails.hidden = !presentation.hasRaw;
    rawContent.textContent = presentation.raw || "{}";
    copyText = presentation.copyText || "";
    copyButton.textContent = presentation.copyLabel || "复制内容";
  } else if (isElicitation) {
    renderMetadata([]);
    renderQuestions(item.questions, true, item);
    rawDetails.hidden = true;
    primaryLabel.hidden = true;
    primaryCode.hidden = true;
    primaryProse.hidden = true;
    copyText = "";
  } else if (isInputRequest) {
    renderMetadata([]);
    renderQuestions(item.questions);
    rawDetails.hidden = true;
    if (Array.isArray(item.questions) && item.questions.length) {
      primaryLabel.hidden = true;
      primaryCode.hidden = true;
      primaryProse.hidden = true;
    } else {
      setPrimaryProse(item.content || "请回到 Codex 原生界面完成选择。");
    }
    copyText = item.content || "";
    copyButton.textContent = "复制内容";
  } else {
    renderMetadata([]);
    renderQuestions([]);
    rawDetails.hidden = true;
    setPrimaryProse(item.output || "任务已完成");
    copyText = item.output || "";
    copyButton.textContent = "复制内容";
  }

  copyButton.hidden = !copyText;
  renderActions(item, isActionable);
  if (isExpanded) scheduleMeasurement();
}

compact.addEventListener("click", () => {
  if (!state?.current) return;
  window.islandAPI.view(state.current.id, "expand");
});
compact.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") compact.click();
});
closeButton.addEventListener("click", () => state?.current && window.islandAPI.close(state.current.id));
copyButton.addEventListener("click", () => {
  window.islandAPI.copy(copyText);
  copyButton.textContent = "已复制";
});
overflowToggle.addEventListener("click", () => { overflowMenu.hidden = !overflowMenu.hidden; });
rawDetails.addEventListener("toggle", scheduleMeasurement);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && state?.current && state.mode.endsWith("expanded")) {
    window.islandAPI.view(state.current.id, "collapse");
  }
});

window.islandAPI.onState(render);
