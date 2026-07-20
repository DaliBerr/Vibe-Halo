"use strict";

const island = document.getElementById("island");
const compact = document.getElementById("compact");
const expanded = document.getElementById("expanded");
const compactAgent = document.getElementById("compact-agent");
const compactSummary = document.getElementById("compact-summary");
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
const rawSummary = document.getElementById("raw-summary");
const rawContent = document.getElementById("raw-content");
const collapseButton = document.getElementById("collapse");
const closeButton = document.getElementById("close");
const copyButton = document.getElementById("copy");
const actions = document.getElementById("actions");
const overflowActions = document.getElementById("overflow-actions");
const overflowToggle = document.getElementById("overflow-toggle");
const overflowMenu = document.getElementById("overflow-menu");
const agentBadge = document.getElementById("agent-badge");

const canvas = document.createElement("canvas");
const context = canvas.getContext("2d");
let state = null;
let copyText = "";
let lastItemId = null;
let measurementFrame = null;
let lastMeasurement = "";

const defaultStrings = Object.freeze({
  collapseIsland: "Collapse island",
  collapse: "Collapse",
  close: "Close",
  rawDetails: "View full parameters",
  copyContent: "Copy content",
  copied: "Copied",
  moreActions: "More actions",
  more: "More",
  parameter: "Parameter",
  option: "Option",
  otherAnswerOptional: "Other answer (optional)",
  enterAnswer: "Enter an answer",
  content: "Content",
  waitingInput: "{agentName} is waiting for your input.",
  waitingAnswerCompact: "Waiting for an answer",
  approvalRequestCompact: "{toolName} approval request",
  waitingChoiceCompact: "{agentName} is waiting for your choice",
  waitingChoiceSummary: "Waiting for your choice",
  completedCompact: "{agentName} completed",
  completedSummary: "Completed",
  planReadySummary: "Plan ready",
  waitingYourAnswer: "{agentName} is waiting for your answer",
  returnToClient: "Return to {agentName} to finish the choice in its native interface.",
  taskCompleted: "Task completed",
});

function ui(key) {
  return state?.strings?.[key] || defaultStrings[key] || key;
}

function formatUi(key, params = {}) {
  return ui(key).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

function applyStaticStrings() {
  document.documentElement.lang = state?.locale === "zh-CN" ? "zh-CN" : "en-US";
  collapseButton.setAttribute("aria-label", ui("collapseIsland"));
  collapseButton.title = ui("collapse");
  closeButton.setAttribute("aria-label", ui("close"));
  rawSummary.textContent = ui("rawDetails");
  overflowToggle.setAttribute("aria-label", ui("moreActions"));
  overflowToggle.textContent = ui("more");
}

function applyAgentAppearance(item, agentName) {
  const source = item?.agentAppearance || {};
  const color = value => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null);
  const accent = color(source.accent) || "#64748B";
  const inkLight = color(source.inkLight) || "#334155";
  const inkDark = color(source.inkDark) || "#CBD5E1";
  const glyph = typeof source.glyph === "string" && /^.{1,2}$/u.test(source.glyph)
    ? source.glyph
    : "A";
  document.documentElement.style.setProperty("--agent-accent", accent);
  document.documentElement.style.setProperty("--agent-ink-light", inkLight);
  document.documentElement.style.setProperty("--agent-ink-dark", inkDark);
  compactAgent.textContent = agentName;
  compactAgent.title = agentName;
  agentBadge.textContent = glyph;
}

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function renderMetadata(items) {
  clearElement(metadata);
  const values = Array.isArray(items) ? items : [];
  metadata.hidden = values.length === 0;
  for (const item of values) {
    const term = document.createElement("dt");
    term.textContent = item.label || ui("parameter");
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
    text.textContent = question.question || formatUi("waitingInput", { agentName: item?.agentName || "Codex" });
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
        label.textContent = option.label || ui("option");
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
      textarea.placeholder = question.options?.length ? ui("otherAnswerOptional") : ui("enterAnswer");
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
  primaryLabel.textContent = label || ui("content");
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
  applyStaticStrings();
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
  applyAgentAppearance(item, agentName);
  compactSummary.textContent = isActionable
    ? (isElicitation ? ui("waitingAnswerCompact") : formatUi("approvalRequestCompact", { toolName: item.toolName }))
    : (isInputRequest
      ? ui("waitingChoiceSummary")
      : ui(item.completionKind === "plan" ? "planReadySummary" : "completedSummary"));
  compact.setAttribute("aria-label", `${agentName} · ${compactSummary.textContent}`);
  count.hidden = (!isActionable && !isInputRequest) || next.pendingCount <= 1;
  count.textContent = String(next.pendingCount);
  title.textContent = isActionable
    ? (isElicitation ? formatUi("waitingYourAnswer", { agentName }) : `${agentName} · ${item.toolName}`)
    : (item.title || (isInputRequest
      ? formatUi("waitingChoiceCompact", { agentName })
      : formatUi("completedCompact", { agentName })));
  subtitle.textContent = item.cwd || item.sessionId || agentName;
  const explanation = isInputRequest ? formatUi("returnToClient", { agentName }) : (isActionable ? item.description : "");
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
    copyButton.textContent = presentation.copyLabel || ui("copyContent");
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
    renderQuestions(item.questions, false, item);
    rawDetails.hidden = true;
    if (Array.isArray(item.questions) && item.questions.length) {
      primaryLabel.hidden = true;
      primaryCode.hidden = true;
      primaryProse.hidden = true;
    } else {
      setPrimaryProse(item.content || formatUi("returnToClient", { agentName }));
    }
    copyText = item.content || "";
    copyButton.textContent = ui("copyContent");
  } else {
    renderMetadata([]);
    renderQuestions([]);
    rawDetails.hidden = true;
    setPrimaryProse(item.output || ui("taskCompleted"));
    copyText = item.output || "";
    copyButton.textContent = ui("copyContent");
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
collapseButton.addEventListener("click", () => {
  if (!state?.current || !state.mode.endsWith("expanded")) return;
  window.islandAPI.view(state.current.id, "collapse");
});
copyButton.addEventListener("click", () => {
  window.islandAPI.copy(copyText);
  copyButton.textContent = ui("copied");
});
overflowToggle.addEventListener("click", () => { overflowMenu.hidden = !overflowMenu.hidden; });
rawDetails.addEventListener("toggle", scheduleMeasurement);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && state?.current && state.mode.endsWith("expanded")) {
    window.islandAPI.view(state.current.id, "collapse");
  }
});

window.islandAPI.onState(render);
