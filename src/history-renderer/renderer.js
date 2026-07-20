"use strict";

const panel = document.getElementById("history");
const listView = document.getElementById("list-view");
const detailView = document.getElementById("detail-view");
const title = document.getElementById("title");
const subtitle = document.getElementById("subtitle");
const privacyNote = document.getElementById("privacy-note");
const plaintextWarning = document.getElementById("plaintext-warning");
const clearButton = document.getElementById("clear");
const closeButton = document.getElementById("close");
const detailCloseButton = document.getElementById("detail-close");
const kindFilters = document.getElementById("kind-filters");
const clientFilter = document.getElementById("client-filter");
const filters = document.getElementById("filters");
const eventList = document.getElementById("event-list");
const empty = document.getElementById("empty");
const backButton = document.getElementById("back");
const deleteButton = document.getElementById("delete");
const detailScroll = document.getElementById("detail-scroll");
const detailBadge = document.getElementById("detail-badge");
const detailTitle = document.getElementById("detail-title");
const detailSubtitle = document.getElementById("detail-subtitle");
const detailOutcome = document.getElementById("detail-outcome");
const detailSections = document.getElementById("detail-sections");
const truncated = document.getElementById("truncated");

const defaults = Object.freeze({
  title: "Recent events", itemCount: "{count} events · last 30 days",
  localSensitive: "Stored locally. History can contain sensitive commands and answers.",
  unencryptedWarning: "History is stored unencrypted on this system.",
  filterAll: "All", filterApproval: "Approvals", filterQuestion: "Questions", filterPlan: "Plans",
  filterAria: "Filter recent events", clientFilterAria: "Filter by client",
  allClients: "All clients", empty: "No matching recent events", clear: "Clear all",
  close: "Close history", back: "Back", delete: "Delete", copy: "Copy", copied: "Copied",
  command: "Command or primary content", parameters: "Full parameters", answers: "Answers",
  content: "Content", result: "Result", reason: "Reason", cwd: "Working directory",
  created: "Requested", finished: "Finished", truncated: "Some oversized content was truncated.",
  noAnswer: "Completed in the client; the answer was not available.",
});

let state = null;
let selectedId = null;
let kind = "all";
let client = "all";

function ui(key, params = {}) {
  const template = state?.strings?.[key] || defaults[key] || key;
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function applyAppearance(element, appearance) {
  const color = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  element.style.setProperty("--agent-accent", color(appearance?.accent) || "#64748B");
  const ink = state?.theme === "light" ? appearance?.inkLight : appearance?.inkDark;
  element.style.setProperty("--agent-ink", color(ink) || (state?.theme === "light" ? "#334155" : "#CBD5E1"));
}

function glyph(item) {
  return typeof item?.agentAppearance?.glyph === "string" ? item.agentAppearance.glyph.slice(0, 2) : "A";
}

function projectName(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
}

function relativeTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(state?.locale || "en-US", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function absoluteTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(state?.locale || "en-US", { dateStyle: "medium", timeStyle: "medium" }).format(timestamp);
}

function kindLabel(value) {
  if (value === "approval") return ui("filterApproval");
  if (value === "question") return ui("filterQuestion");
  return ui("filterPlan");
}

function eventTitle(item) {
  if (item.title) return item.title;
  if (item.kind === "approval") return item.toolName || ui("filterApproval");
  if (item.kind === "question") return item.toolName || ui("filterQuestion");
  return ui("filterPlan");
}

function buildClientFilter(items) {
  const previous = clientFilter.value || client;
  clearElement(clientFilter);
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = ui("allClients");
  clientFilter.appendChild(all);
  const clients = new Map();
  for (const item of items) clients.set(item.agentId, item.agentName || item.agentId);
  for (const [id, name] of [...clients.entries()].sort((left, right) => left[1].localeCompare(right[1]))) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = name;
    clientFilter.appendChild(option);
  }
  client = clients.has(previous) ? previous : "all";
  clientFilter.value = client;
}

function renderList() {
  if (!state) return;
  document.documentElement.lang = state.locale === "zh-CN" ? "zh-CN" : "en-US";
  document.documentElement.dataset.theme = state.theme === "light" ? "light" : "dark";
  title.textContent = ui("title");
  subtitle.textContent = ui("itemCount", { count: state.storage?.count ?? state.items.length });
  privacyNote.textContent = ui("localSensitive");
  plaintextWarning.textContent = ui("unencryptedWarning");
  plaintextWarning.hidden = state.storage?.mode !== "plaintext";
  clearButton.textContent = ui("clear");
  clearButton.disabled = state.items.length === 0;
  closeButton.setAttribute("aria-label", ui("close"));
  detailCloseButton.setAttribute("aria-label", ui("close"));
  filters.setAttribute("aria-label", ui("filterAria"));
  clientFilter.setAttribute("aria-label", ui("clientFilterAria"));
  document.title = `Vibe Halo — ${ui("title")}`;
  const labels = ["filterAll", "filterApproval", "filterQuestion", "filterPlan"];
  [...kindFilters.querySelectorAll("button")].forEach((button, index) => {
    button.textContent = ui(labels[index]);
    button.classList.toggle("active", button.dataset.kind === kind);
  });
  buildClientFilter(state.items);
  clearElement(eventList);
  const visible = state.items.filter(item => (kind === "all" || item.kind === kind) && (client === "all" || item.agentId === client));
  for (const item of visible) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "event-card";
    card.setAttribute("role", "listitem");
    applyAppearance(card, item.agentAppearance);

    const badge = document.createElement("span");
    badge.className = "event-badge";
    badge.textContent = glyph(item);
    const copy = document.createElement("span");
    copy.className = "event-copy";
    const top = document.createElement("span");
    top.className = "event-top";
    const agent = document.createElement("span");
    agent.className = "event-agent";
    agent.textContent = `${item.agentName || item.agentId} · ${kindLabel(item.kind)}`;
    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = relativeTime(item.finalizedAt);
    top.append(agent, time);
    const itemTitle = document.createElement("span");
    itemTitle.className = "event-title";
    itemTitle.textContent = item.kind === "plan" ? eventTitle(item) : `${eventTitle(item)} · ${item.outcomeLabel}`;
    const summary = document.createElement("span");
    summary.className = "event-summary";
    summary.textContent = item.summary || projectName(item.cwd) || item.sessionId || "";
    copy.append(top, itemTitle, summary);
    const chevron = document.createElement("span");
    chevron.className = "event-chevron";
    chevron.textContent = "›";
    card.append(badge, copy, chevron);
    card.addEventListener("click", () => showDetail(item.id));
    eventList.appendChild(card);
  }
  empty.textContent = ui("empty");
  empty.hidden = visible.length > 0;
  eventList.hidden = visible.length === 0;
}

function section(label, text, options = {}) {
  if (!text) return null;
  const article = document.createElement("section");
  article.className = "detail-section";
  const header = document.createElement("div");
  header.className = "section-header";
  const heading = document.createElement("span");
  heading.className = "section-title";
  heading.textContent = label;
  header.appendChild(heading);
  if (options.copySection) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.textContent = ui("copy");
    button.addEventListener("click", async () => {
      if (!selectedId) return;
      const copied = await window.historyAPI.copy(selectedId, options.copySection);
      if (!copied) return;
      button.textContent = ui("copied");
      setTimeout(() => { button.textContent = ui("copy"); }, 1000);
    });
    header.appendChild(button);
  }
  const body = document.createElement(options.code ? "pre" : "div");
  body.className = options.code ? "section-code" : "section-prose";
  body.textContent = text;
  article.append(header, body);
  return article;
}

function metadataSection(detail) {
  const article = document.createElement("section");
  article.className = "detail-section";
  const header = document.createElement("div");
  header.className = "section-header";
  const heading = document.createElement("span");
  heading.className = "section-title";
  heading.textContent = ui("result");
  header.appendChild(heading);
  const list = document.createElement("dl");
  list.className = "metadata-grid";
  const rows = [
    [ui("result"), detail.outcomeLabel],
    [ui("reason"), detail.reasonLabel || detail.reason],
    [ui("created"), absoluteTime(detail.createdAt)],
    [ui("finished"), absoluteTime(detail.finalizedAt)],
    [ui("cwd"), detail.cwd],
  ].filter(row => row[1]);
  for (const [name, value] of rows) {
    const term = document.createElement("dt");
    term.textContent = name;
    const description = document.createElement("dd");
    description.textContent = value;
    list.append(term, description);
  }
  article.append(header, list);
  return article;
}

function questionsSection(detail) {
  if (!Array.isArray(detail.questions) || detail.questions.length === 0) return null;
  const article = document.createElement("section");
  article.className = "detail-section";
  const header = document.createElement("div");
  header.className = "section-header";
  const heading = document.createElement("span");
  heading.className = "section-title";
  heading.textContent = ui("filterQuestion");
  header.appendChild(heading);
  article.appendChild(header);
  for (const question of detail.questions) {
    const block = document.createElement("div");
    block.className = "question-detail";
    const name = document.createElement("div");
    name.className = "question-name";
    name.textContent = question.question || question.header || question.id;
    const options = document.createElement("div");
    options.className = "question-options";
    options.textContent = (question.options || []).map(option => option.label).filter(Boolean).join(" · ");
    block.appendChild(name);
    if (options.textContent) block.appendChild(options);
    article.appendChild(block);
  }
  return article;
}

async function showDetail(id) {
  const detail = await window.historyAPI.get(id);
  if (!detail) return;
  selectedId = id;
  listView.hidden = true;
  detailView.hidden = false;
  applyAppearance(detailView, detail.agentAppearance);
  detailBadge.textContent = glyph(detail);
  detailTitle.textContent = eventTitle(detail);
  detailSubtitle.textContent = `${detail.agentName || detail.agentId} · ${kindLabel(detail.kind)} · ${absoluteTime(detail.finalizedAt)}`;
  detailOutcome.textContent = detail.outcomeLabel;
  backButton.querySelector("span").textContent = ui("back");
  deleteButton.textContent = ui("delete");
  truncated.textContent = ui("truncated");
  truncated.hidden = detail.truncated !== true;
  clearElement(detailSections);
  detailSections.appendChild(metadataSection(detail));
  const presentation = detail.presentation;
  const primary = section(presentation?.label || ui("command"), presentation?.primary, { copySection: "primary", code: true });
  if (primary) detailSections.appendChild(primary);
  const parameters = section(ui("parameters"), presentation?.raw, { copySection: "parameters", code: true });
  if (parameters) detailSections.appendChild(parameters);
  const questions = questionsSection(detail);
  if (questions) detailSections.appendChild(questions);
  const answerText = detail.answersText || (detail.kind === "question" && detail.questions?.length && detail.answerAvailable !== true ? ui("noAnswer") : "");
  const answers = section(ui("answers"), answerText, { copySection: detail.answersText ? "answers" : null, code: !!detail.answersText });
  if (answers) detailSections.appendChild(answers);
  const content = section(ui("content"), detail.content, { copySection: "content", code: false });
  if (content) detailSections.appendChild(content);
  detailScroll.scrollTop = 0;
}

function showList() {
  selectedId = null;
  detailView.hidden = true;
  listView.hidden = false;
  renderList();
  eventList.scrollTop = 0;
}

async function reload() {
  const next = await window.historyAPI.list();
  if (!next) return;
  state = next;
  if (selectedId) {
    const detail = await window.historyAPI.get(selectedId);
    if (detail) await showDetail(selectedId);
    else showList();
  } else renderList();
}

kindFilters.addEventListener("click", event => {
  const button = event.target.closest("button[data-kind]");
  if (!button) return;
  kind = button.dataset.kind;
  renderList();
});
clientFilter.addEventListener("change", () => { client = clientFilter.value; renderList(); });
clearButton.addEventListener("click", async () => { if (await window.historyAPI.clear()) await reload(); });
closeButton.addEventListener("click", () => window.historyAPI.close());
detailCloseButton.addEventListener("click", () => window.historyAPI.close());
backButton.addEventListener("click", showList);
deleteButton.addEventListener("click", async () => {
  if (selectedId && await window.historyAPI.delete(selectedId)) { selectedId = null; await reload(); showList(); }
});
document.documentElement.addEventListener("mouseenter", () => window.historyAPI.pointer(true));
document.documentElement.addEventListener("mouseleave", () => window.historyAPI.pointer(false));
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (selectedId) showList();
  else window.historyAPI.close();
});
window.historyAPI.onChanged(reload);
window.historyAPI.onReset(() => { kind = "all"; client = "all"; showList(); reload(); });
window.historyAPI.onFade(value => panel.classList.toggle("fading", value === true));
reload();
