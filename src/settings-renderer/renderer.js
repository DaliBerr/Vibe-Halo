"use strict";

(() => {
  const api = window.settingsAPI;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    gear: "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Zm5.5 2.4c0-.3 0-.6-.1-.9l1.4-1.1-1.4-2.4-1.7.6a5.3 5.3 0 0 0-1.5-.9L9.9 1.5H7.1l-.3 1.8c-.5.2-1 .5-1.5.9l-1.7-.6L2.2 6l1.4 1.1a5.6 5.6 0 0 0 0 1.8L2.2 10l1.4 2.4 1.7-.6c.5.4 1 .7 1.5.9l.3 1.8h2.8l.3-1.8c.5-.2 1-.5 1.5-.9l1.7.6 1.4-2.4-1.4-1.1c.1-.3.1-.6.1-.9Z",
    clock: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Zm0 1.3a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8Zm-.6 1.6v3.7l3 1.8.6-1-2.4-1.5V4.7H7.4Z",
    phone: "M5.2 1.5h5.6c.8 0 1.4.6 1.4 1.4v10.2c0 .8-.6 1.4-1.4 1.4H5.2c-.8 0-1.4-.6-1.4-1.4V2.9c0-.8.6-1.4 1.4-1.4Zm0 1.3v10.4h5.6V2.8H5.2Zm1.9 8.5h1.8v1.1H7.1v-1.1Z",
    refresh: "M8 2.2a5.8 5.8 0 0 0-5.3 3.5l1.2.5A4.5 4.5 0 0 1 11.8 5H9.6v1.3h4.2V2.1h-1.3v1.8A5.8 5.8 0 0 0 8 2.2Zm4.1 7.6A4.5 4.5 0 0 1 4.2 11h2.2V9.7H2.2v4.2h1.3v-1.8a5.8 5.8 0 0 0 9.8-1.8l-1.2-.5Z",
    folder: "M2 3.5h4.3l1.3 1.4H14v7.6H2V3.5Zm1.3 1.3v6.4h9.4V6.2H7L5.7 4.8H3.3Z",
    back: "M10.3 2.6 5 8l5.3 5.4.9-.9L6.8 8l4.4-4.5-.9-.9Z",
    chevron: "M5.7 2.6 11 8l-5.3 5.4-.9-.9L9.2 8 4.8 3.5l.9-.9Z",
  };

  let state = null;
  let page = "general";
  let toastTimer = null;
  let history = null;
  let historyDetail = null;
  let historyKind = "all";
  let historyClient = "all";
  let draftName = null;
  let pairReadOnly = false;
  let pairPersistent = false;
  const busy = new Set();

  const S = key => (state?.strings?.[key] ?? key);
  const fmt = (key, params = {}) => String(S(key)).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));

  function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : String(value));
    }
    if (options.dataset) for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
    if (options.onClick) node.addEventListener("click", options.onClick);
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  function icon(name, className = "button-icon") {
    const wrap = el("span", { className, attrs: { "aria-hidden": "true" } });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "currentColor");
    const pathNode = document.createElementNS(SVG_NS, "path");
    pathNode.setAttribute("d", ICONS[name] || "");
    pathNode.setAttribute("fill-rule", "evenodd");
    svg.append(pathNode);
    wrap.append(svg);
    return wrap;
  }

  function fillIcons(root = document) {
    for (const node of root.querySelectorAll("[data-icon]")) {
      if (!node.firstChild) node.append(icon(node.dataset.icon, "").firstChild);
    }
  }

  function safeColor(value, fallback) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function safeIconSource(value) {
    return typeof value === "string" && /^icons\/[a-z0-9-]{1,80}\.svg$/.test(value) ? value : null;
  }

  /** The client's app icon when bundled, otherwise its colored glyph badge. */
  function agentMark(agentId, appearance, size = "small") {
    const iconInfo = state?.icons?.[agentId] || null;
    const source = safeIconSource(iconInfo?.src);
    const node = el("span", { className: `agent-mark ${size}`, attrs: { "aria-hidden": "true" } });
    const dark = state?.theme === "dark";
    node.style.setProperty("--agent-accent", safeColor(appearance?.accent, "#64748B"));
    node.style.setProperty("--agent-ink", safeColor(dark ? appearance?.inkDark : appearance?.inkLight, dark ? "#CBD5E1" : "#334155"));
    if (source && iconInfo.mono) {
      const mask = el("span", { className: "icon-mask" });
      mask.style.setProperty("--icon-url", `url("${source}")`);
      node.append(mask);
      node.classList.add("has-icon");
    } else if (source) {
      node.append(el("img", { attrs: { src: source, alt: "", draggable: "false" } }));
      node.classList.add("has-icon");
    } else {
      node.classList.add("glyph");
      node.textContent = typeof appearance?.glyph === "string" ? appearance.glyph.slice(0, 2) : "?";
    }
    return node;
  }

  function statusLabel(status) {
    const key = { healthy: "statusHealthy", repair: "statusRepair", review: "statusReview", notDetected: "statusNotDetected", clientDisabled: "statusClientDisabled", unavailable: "statusUnavailable" }[status] || "statusOff";
    return S(key);
  }

  function showToast(message) {
    const node = document.getElementById("toast");
    if (!message?.text) return;
    node.textContent = message.text;
    node.className = `toast${message.tone === "error" ? " error" : ""}`;
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, message.tone === "error" ? 6000 : 2600);
  }

  function optimistic(payload) {
    if (payload.type === "general" && state.general && typeof payload.value === typeof state.general[payload.key]) {
      state.general[payload.key] = payload.value;
    }
    const client = payload.agentId ? state.clients.find(item => item.id === payload.agentId) : null;
    if (client && payload.type === "client-enabled") client.enabled = payload.value;
    if (client && payload.type === "client-visible") client.visible = payload.value;
    if (client && payload.type === "client-preference") client.preferences[payload.key] = payload.value;
  }

  async function act(key, payload, options = {}) {
    if (busy.has(key)) return null;
    busy.add(key);
    optimistic(payload);
    if (!options.quiet) render();
    let result = null;
    try { result = await api.action(payload); }
    catch { result = null; }
    busy.delete(key);
    if (result?.state) state = result.state;
    if (result?.history) history = result.history;
    if (result?.companion && state) state.companion = result.companion;
    if (!options.silent) render();
    if (result?.message) showToast(result.message);
    return result;
  }

  function switchControl({ checked, disabled, label, key, onChange }) {
    const input = el("input", { attrs: { type: "checkbox", role: "switch", "aria-label": label } });
    input.checked = !!checked;
    input.disabled = !!disabled || busy.has(key);
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { className: `switch${busy.has(key) ? " busy" : ""}` }, [input, el("span")]);
  }

  function button(label, options = {}) {
    return el("button", {
      className: `button${options.tone ? ` ${options.tone}` : ""}`,
      attrs: { type: "button", disabled: options.disabled || (options.key && busy.has(options.key)) },
      onClick: options.onClick,
    }, [options.icon ? icon(options.icon) : null, label ? el("span", { text: label }) : null]);
  }

  function settingRow({ title, hint, control, disabled, meta, lead }) {
    return el("div", { className: `row${disabled ? " disabled" : ""}` }, [
      lead || null,
      el("div", { className: "row-copy" }, [title ? el("div", { className: "row-title", text: title }) : null, hint ? el("div", { className: "row-hint", text: hint }) : null]),
      meta ? el("span", { className: "row-meta", text: meta }) : null,
      control,
    ]);
  }

  function section(title, children, description) {
    return el("section", { className: "section" }, [
      title ? el("h2", { className: "section-title", text: title }) : null,
      description ? el("p", { className: "section-description", text: description }) : null,
      el("div", { className: "card" }, children),
    ]);
  }

  function pill(text, status) {
    return el("span", { className: "pill", dataset: { status } }, [el("span", { className: "status-dot" }), el("span", { text })]);
  }

  function pageHeader(title, subtitle, extra = [], lead = null) {
    return el("header", { className: "page-header" }, [
      lead,
      el("div", { className: "page-header-copy" }, [
        el("div", { className: "title-line" }, [el("h1", { text: title }), ...extra.filter(Boolean)]),
        subtitle ? el("p", { text: subtitle }) : null,
      ]),
    ]);
  }

  // Sidebar ---------------------------------------------------------------

  function sidebarClients() {
    return state.clients.filter(client => client.available && client.visible && client.detected);
  }

  function companionStatus() {
    const companion = state.companion;
    if (!companion || !companion.enabled) return "off";
    if (companion.status === "connected") return "healthy";
    if (["connecting", "lan_unavailable", "offline"].includes(companion.status)) return "repair";
    return "clientDisabled";
  }

  function renderSidebar() {
    document.getElementById("brand-version").textContent = fmt("version", { version: state.general.version });
    for (const node of document.querySelectorAll("[data-label]")) node.textContent = S(node.dataset.label);
    for (const node of document.querySelectorAll(".nav-item[data-page]")) {
      const active = node.dataset.page === page;
      node.classList.toggle("active", active);
      node.setAttribute("aria-current", active ? "page" : "false");
    }
    const count = state.general.historyCount;
    document.getElementById("history-count").textContent = count ? String(count) : "";
    document.getElementById("mobile-dot").dataset.status = companionStatus();
    const nav = document.getElementById("client-nav");
    nav.setAttribute("aria-label", S("clients"));
    nav.replaceChildren();
    const clients = sidebarClients();
    if (!clients.length) {
      nav.append(el("button", { className: "nav-empty", text: S("sidebarEmpty"), attrs: { type: "button" }, onClick: () => navigate("general") }));
    }
    for (const client of clients) {
      nav.append(el("button", {
        className: `client-item${page === client.id ? " active" : ""}${client.enabled ? "" : " dim"}`,
        attrs: { type: "button", "aria-current": page === client.id ? "page" : "false", title: `${client.name} · ${statusLabel(client.status)}` },
        dataset: { page: client.id },
        onClick: () => navigate(client.id),
      }, [
        agentMark(client.id, client.appearance),
        el("span", { className: "client-name", text: client.name }),
        el("span", { className: "status-dot", dataset: { status: client.enabled ? client.status : "off" }, attrs: { "aria-hidden": "true" } }),
      ]));
    }
  }

  // General page ----------------------------------------------------------

  function generalSwitch(key, title, hint) {
    return settingRow({
      title, hint,
      control: switchControl({
        checked: state.general[key], label: title, key: `general:${key}`,
        onChange: value => act(`general:${key}`, { type: "general", key, value }),
      }),
    });
  }

  function updateRow() {
    const update = state.general.update;
    const version = update.availableVersion || "";
    let hint = S("updatesDisabled");
    let control = null;
    if (update.enabled) {
      const map = {
        checking: fmt("updateChecking"),
        available: fmt("updateAvailable", { version }),
        downloading: fmt("updateDownloading", { version, percent: update.percent ?? 0 }),
        downloaded: fmt("updateDownloaded", { version }),
        installing: fmt("updateInstalling"),
        error: S("updateError"),
      };
      hint = map[update.status] || S("updateIdle");
      if (update.status === "downloaded") control = button(S("restartAndUpdate"), { tone: "primary", key: "install-update", onClick: () => act("install-update", { type: "install-update" }) });
      else if (["idle", "error", "disabled"].includes(update.status)) control = button(S("checkUpdates"), { icon: "refresh", key: "check-updates", onClick: () => act("check-updates", { type: "check-updates" }) });
    }
    return settingRow({ title: fmt("version", { version: state.general.version }), hint, control });
  }

  function renderGeneral(root) {
    const general = state.general;
    root.append(pageHeader(S("general"), S("generalSubtitle")));

    const detected = state.clients.filter(client => client.available && client.detected);
    const hidden = state.clients.filter(client => client.available && !client.detected).length;
    const rows = detected.map(client => settingRow({
      lead: agentMark(client.id, client.appearance),
      title: client.name,
      hint: statusLabel(client.status),
      control: switchControl({
        checked: client.visible,
        label: client.name,
        key: `visible:${client.id}`,
        onChange: value => act(`visible:${client.id}`, { type: "client-visible", agentId: client.id, value }),
      }),
    }));
    if (!rows.length) rows.push(settingRow({ hint: S("noDetectedClients") }));
    rows.push(settingRow({
      hint: hidden ? fmt("hiddenUndetected", { count: hidden }) : S("integrationSummaryHint"),
      control: el("div", { className: "row-actions" }, [
        button(S("rescan"), { icon: "refresh", key: "rescan", onClick: () => act("rescan", { type: "rescan" }) }),
        button(S("repairAll"), { key: "repair-all", disabled: !state.summary.enabled, onClick: () => act("repair-all", { type: "repair-all" }) }),
      ]),
    }));
    root.append(section(S("sectionClientsShown"), rows, S("clientsShownHint")));

    root.append(section(S("sectionBehavior"), [
      generalSwitch("approvalEnabled", S("approvalEnabled"), S("approvalEnabledHint")),
      generalSwitch("inputReminderEnabled", S("inputReminderEnabled"), S("inputReminderEnabledHint")),
      generalSwitch("historyEnabled", S("historyEnabled"), S("historyEnabledHint")),
    ]));

    const languages = el("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": S("language") } });
    for (const [value, label] of [["system", S("languageSystem")], ["zh-CN", "简体中文"], ["en-US", "English"]]) {
      languages.append(el("button", {
        className: general.language === value ? "active" : "",
        text: label,
        attrs: { type: "button", role: "radio", "aria-checked": general.language === value ? "true" : "false", disabled: busy.has("general:language") },
        onClick: () => general.language !== value && act("general:language", { type: "general", key: "language", value }),
      }));
    }
    root.append(section(S("sectionSystem"), [
      generalSwitch("openAtLogin", S("openAtLogin"), S("openAtLoginHint")),
      settingRow({ title: S("language"), hint: S("languageHint"), control: languages }),
    ]));

    root.append(section(S("sectionAbout"), [
      updateRow(),
      settingRow({
        title: S("diagnostics"),
        control: el("div", { className: "row-actions" }, [
          button(S("openLogs"), { icon: "folder", onClick: () => act("open-logs", { type: "open-logs" }) }),
          button(S("diagnostics"), { key: "copy-diagnostics", onClick: () => act("copy-diagnostics", { type: "copy-diagnostics" }) }),
          button(S("uninstallAll"), { tone: "danger", key: "uninstall-all", onClick: () => act("uninstall-all", { type: "uninstall-all" }) }),
        ]),
      }),
    ]));
  }

  // Client page -----------------------------------------------------------

  const FEATURE_ROWS = [
    { key: "approvals", title: "featureApprovals", hint: "featureApprovalsHint", global: "approvalEnabled" },
    { key: "questions", title: "featureQuestions", hint: "featureQuestionsHint", global: "approvalEnabled" },
    { key: "reminders", title: "featureReminders", hint: "featureRemindersHint", global: "inputReminderEnabled" },
    { key: "completions", title: "featureCompletions", hint: "featureCompletionsHint" },
  ];

  function connectionCard(client) {
    const agentName = client.name;
    const textKey = client.status === "clientDisabled" && client.codex?.featureDisabled ? "codexFeatureOff" : {
      healthy: "connectionHealthy", repair: "connectionRepair", review: "connectionReview", clientDisabled: "connectionClientDisabled",
      notDetected: "connectionNotDetected", unavailable: "platformUnavailable",
    }[client.status] || "connectionOff";
    let control = null;
    if (client.status === "review") {
      control = button(S("copyHooks"), { tone: "primary", onClick: () => act("codex-copy-review", { type: "codex-copy-review" }) });
    } else if (client.status === "clientDisabled" && client.codex?.featureDisabled) {
      control = button(S("codexEnableFeature"), { tone: "primary", key: "codex-enable-feature", onClick: () => act("codex-enable-feature", { type: "codex-enable-feature" }) });
    } else if (client.status === "repair") {
      control = button(S("reconnect"), { tone: "primary", icon: "refresh", key: `repair:${client.id}`, onClick: () => act(`repair:${client.id}`, { type: "client-repair", agentId: client.id }) });
    } else if (client.status === "clientDisabled" || client.status === "notDetected") {
      control = button(S("recheck"), { icon: "refresh", key: "rescan", onClick: () => act("rescan", { type: "rescan" }) });
    }
    const hint = client.reason && client.status !== "healthy" ? fmt("lastError", { reason: client.reason }) : "";
    return section(S("sectionConnection"), [
      settingRow({
        lead: el("span", { className: "status-dot large", dataset: { status: client.enabled ? client.status : "off" }, attrs: { "aria-hidden": "true" } }),
        title: fmt(textKey, { agentName }),
        hint,
        control,
      }),
    ]);
  }

  function renderClient(root, client) {
    const agentName = client.name;
    root.append(pageHeader(agentName, "", [pill(statusLabel(client.status), client.status)], agentMark(client.id, client.appearance, "large")));

    const enableHint = !client.available
      ? S("platformUnavailable")
      : (!client.canToggle ? fmt("enableUnavailable", { agentName }) : fmt("enableClientHint", { agentName }));
    root.append(el("div", { className: "card hero" }, [
      el("div", { className: "hero-row" }, [
        el("div", { className: "hero-copy" }, [
          el("div", { className: "hero-title", text: fmt("enableClient", { agentName }) }),
          el("div", { className: "hero-hint", text: enableHint }),
        ]),
        switchControl({
          checked: client.enabled,
          disabled: !client.canToggle,
          label: fmt("enableClient", { agentName }),
          key: `client:${client.id}`,
          onChange: value => act(`client:${client.id}`, { type: "client-enabled", agentId: client.id, value }),
        }),
      ]),
    ]));

    if (client.enabled) root.append(connectionCard(client));

    const featureRows = FEATURE_ROWS.filter(row => client.features[row.key]).map(row => {
      const globalOff = row.global && !state.general[row.global];
      return settingRow({
        title: S(row.title),
        hint: fmt(row.hint, { agentName }),
        disabled: !client.enabled || globalOff,
        meta: client.enabled && globalOff ? S("featureOffGlobal") : "",
        control: switchControl({
          checked: client.preferences[row.key],
          disabled: !client.enabled,
          label: S(row.title),
          key: `pref:${client.id}:${row.key}`,
          onChange: value => act(`pref:${client.id}:${row.key}`, { type: "client-preference", agentId: client.id, key: row.key, value }),
        }),
      });
    });
    if (!client.enabled) featureRows.unshift(settingRow({ hint: fmt("enableToConfigure", { agentName }) }));
    root.append(section(fmt("sectionFeatures", { agentName }), featureRows));
  }

  // History page ----------------------------------------------------------

  const KIND_KEYS = { all: "history.filterAll", approval: "history.filterApproval", question: "history.filterQuestion", plan: "history.filterPlan" };

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

  function kindLabel(kind) {
    return S(KIND_KEYS[kind] || "history.filterPlan");
  }

  function eventTitle(item) {
    if (item.title) return item.title;
    if (item.kind === "approval") return item.toolName || S("history.filterApproval");
    if (item.kind === "question") return item.toolName || S("history.filterQuestion");
    return S("history.filterPlan");
  }

  function projectName(cwd) {
    if (typeof cwd !== "string" || !cwd) return "";
    return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
  }

  async function loadHistory() {
    const result = await act("history-list", { type: "history-list" }, { quiet: true, silent: true });
    if (result?.history) history = result.history;
    if (historyDetail && !history?.items?.some(item => item.id === historyDetail.id)) historyDetail = null;
    if (page === "history") render();
  }

  async function openHistoryDetail(id) {
    const result = await act(`history-get:${id}`, { type: "history-get", id }, { quiet: true, silent: true });
    if (result?.detail) {
      historyDetail = result.detail;
      render();
      document.getElementById("scroller").scrollTop = 0;
    }
  }

  function renderHistoryList(root) {
    const items = history?.items || [];
    const count = history?.storage?.count ?? state.general.historyCount ?? 0;
    const header = pageHeader(S("history.title"), fmt("history.itemCount", { count }));
    header.append(button(S("history.clear"), {
      tone: "danger", key: "history-clear", disabled: !items.length,
      onClick: () => act("history-clear", { type: "history-clear" }),
    }));
    root.append(header);
    if (history?.storage?.mode === "plaintext") root.append(el("div", { className: "notice" }, [el("p", { text: S("history.unencryptedWarning") })]));

    const kinds = el("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": S("history.filterAria") } });
    for (const kind of Object.keys(KIND_KEYS)) {
      kinds.append(el("button", {
        className: historyKind === kind ? "active" : "",
        text: S(KIND_KEYS[kind]),
        attrs: { type: "button", role: "radio", "aria-checked": historyKind === kind ? "true" : "false" },
        onClick: () => { historyKind = kind; render(); },
      }));
    }
    const select = el("select", { className: "select", attrs: { "aria-label": S("history.clientFilterAria") } });
    const clients = new Map(items.map(item => [item.agentId, item.agentName || item.agentId]));
    if (!clients.has(historyClient)) historyClient = "all";
    select.append(el("option", { text: S("history.allClients"), attrs: { value: "all" } }));
    for (const [id, name] of [...clients.entries()].sort((left, right) => left[1].localeCompare(right[1]))) {
      select.append(el("option", { text: name, attrs: { value: id } }));
    }
    select.value = historyClient;
    select.addEventListener("change", () => { historyClient = select.value; render(); });
    root.append(el("div", { className: "toolbar" }, [kinds, select]));

    const visible = items.filter(item => (historyKind === "all" || item.kind === historyKind) && (historyClient === "all" || item.agentId === historyClient));
    if (!history) {
      root.append(el("div", { className: "empty-state", text: S("history.loading") }));
    } else if (!visible.length) {
      root.append(el("div", { className: "empty-state", text: S("history.empty") }));
    } else {
      const list = el("div", { className: "card event-list", attrs: { id: "event-list", role: "list" } });
      for (const item of visible) {
        list.append(el("button", {
          className: "event-card",
          attrs: { type: "button", role: "listitem", title: S("history.openDetail") },
          onClick: () => openHistoryDetail(item.id),
        }, [
          agentMark(item.agentId, item.agentAppearance),
          el("span", { className: "event-copy" }, [
            el("span", { className: "event-top" }, [
              el("span", { className: "event-agent", text: `${item.agentName || item.agentId} · ${kindLabel(item.kind)}` }),
              el("span", { className: "event-time", text: relativeTime(item.finalizedAt) }),
            ]),
            el("span", { className: "event-title", text: item.kind === "plan" ? eventTitle(item) : `${eventTitle(item)} · ${item.outcomeLabel || ""}` }),
            el("span", { className: "event-summary", text: item.summary || projectName(item.cwd) || item.sessionId || "" }),
          ]),
          icon("chevron", "event-chevron"),
        ]));
      }
      root.append(list);
    }
    root.append(el("p", { className: "footnote", text: S("history.localSensitive") }));
  }

  function detailBlock(label, text, options = {}) {
    if (!text) return null;
    const header = el("div", { className: "detail-head" }, [el("span", { className: "detail-label", text: label })]);
    if (options.copySection) {
      header.append(button(S("history.copy"), {
        key: `copy:${options.copySection}`,
        onClick: () => act(`copy:${options.copySection}`, { type: "history-copy", id: historyDetail.id, section: options.copySection }, { quiet: true, silent: true }),
      }));
    }
    return el("section", { className: "card detail-block" }, [header, el(options.code ? "pre" : "div", { className: options.code ? "detail-code" : "detail-prose", text })]);
  }

  function renderHistoryDetail(root) {
    const detail = historyDetail;
    const view = el("div", { attrs: { id: "detail-view" } });
    view.append(el("div", { className: "detail-nav" }, [
      button(S("history.back"), { icon: "back", onClick: () => { historyDetail = null; render(); } }),
      button(S("history.delete"), { tone: "danger", key: `history-delete:${detail.id}`, onClick: async () => {
        const result = await act(`history-delete:${detail.id}`, { type: "history-delete", id: detail.id }, { quiet: true, silent: true });
        if (result?.ok) historyDetail = null;
        render();
      } }),
    ]));
    view.append(pageHeader(eventTitle(detail), `${detail.agentName || detail.agentId} · ${kindLabel(detail.kind)} · ${absoluteTime(detail.finalizedAt)}`,
      [detail.outcomeLabel ? pill(detail.outcomeLabel, "neutral") : null], agentMark(detail.agentId, detail.agentAppearance, "large")));
    if (detail.truncated) view.append(el("div", { className: "notice" }, [el("p", { text: S("history.truncated") })]));
    const sections = el("div", { className: "detail-sections", attrs: { id: "detail-sections" } });
    const meta = [
      [S("history.result"), detail.outcomeLabel],
      [S("history.reason"), detail.reasonLabel || detail.reason],
      [S("history.created"), absoluteTime(detail.createdAt)],
      [S("history.finished"), absoluteTime(detail.finalizedAt)],
      [S("history.cwd"), detail.cwd],
    ].filter(row => row[1]);
    sections.append(el("dl", { className: "card meta-list" }, meta.map(([name, value]) => el("div", { className: "kv" }, [el("dt", { text: name }), el("dd", { text: value })]))));
    const presentation = detail.presentation;
    for (const block of [
      detailBlock(presentation?.label || S("history.command"), presentation?.primary, { copySection: "primary", code: true }),
      detailBlock(S("history.parameters"), presentation?.raw, { copySection: "parameters", code: true }),
    ]) if (block) sections.append(block);
    if (Array.isArray(detail.questions) && detail.questions.length) {
      const block = el("section", { className: "card detail-block" }, [el("div", { className: "detail-head" }, [el("span", { className: "detail-label", text: S("history.filterQuestion") })])]);
      for (const question of detail.questions) {
        block.append(el("div", { className: "question" }, [
          el("div", { className: "question-name", text: question.question || question.header || question.id }),
          question.detail ? el("div", { className: "question-detail", text: question.detail }) : null,
          (question.options || []).length ? el("div", { className: "question-options", text: question.options.map(option => option.label).filter(Boolean).join(" · ") }) : null,
        ]));
      }
      sections.append(block);
    }
    const answerText = detail.answersText || (detail.kind === "question" && detail.questions?.length && detail.answerAvailable !== true ? S("history.noAnswer") : "");
    for (const block of [
      detailBlock(S("history.answers"), answerText, { copySection: detail.answersText ? "answers" : null, code: !!detail.answersText }),
      detailBlock(S("history.content"), detail.content, { copySection: "content" }),
    ]) if (block) sections.append(block);
    view.append(sections);
    root.append(view);
  }

  // Mobile companion page ---------------------------------------------------

  async function mobileAction(key, request, options = {}) {
    const result = await act(`mobile:${key}`, { type: "mobile", request }, options);
    if (result && !result.ok && !options.quiet) {
      const text = state.strings[`mobile.error.${result.error}`] || S("mobile.error.generic");
      showToast({ tone: "error", text });
    }
    return result;
  }

  function mobileStatusText(companion) {
    return state.strings[`mobile.status.${companion.status}`] || companion.status || S("mobile.status.disabled");
  }

  function validDeviceName(name) {
    return !!name && [...name].length <= 48 && !/[\p{Cc}\p{Cf}]/u.test(name.replace(/‍/g, ""));
  }

  function renderMobile(root) {
    const companion = state.companion;
    root.append(pageHeader(S("mobile.title"), S("mobile.subtitle"), companion ? [pill(mobileStatusText(companion), companionStatus())] : []));
    if (!companion) return;

    const rows = [];
    if (!companion.enrolled) {
      rows.push(settingRow({
        hint: S("mobile.connectingHint"),
        control: button(S("mobile.reconnect"), { icon: "refresh", key: "mobile:configure", disabled: companion.status === "connecting",
          onClick: () => mobileAction("configure", { action: "configure" }, { quiet: true }) }),
      }));
    }
    if (companion.pcId) {
      const input = el("input", { className: "text-input", attrs: { type: "text", autocomplete: "off", spellcheck: "false", maxlength: "64", "aria-label": S("mobile.deviceName") } });
      input.value = draftName ?? companion.name ?? "";
      input.addEventListener("input", () => { draftName = input.value; });
      const save = async () => {
        const name = input.value.trim();
        if (!validDeviceName(name)) { showToast({ tone: "error", text: S("mobile.nameInvalid") }); return; }
        const result = await mobileAction("rename", { action: "rename", name });
        if (result?.ok) { draftName = null; showToast({ tone: "success", text: S("mobile.updated") }); render(); }
      };
      input.addEventListener("keydown", event => { if (event.key === "Enter") save(); });
      const nameHint = S(companion.namePending ? "mobile.namePending" : companion.nameMode === "system" ? "mobile.nameSystem" : "mobile.nameCustom");
      rows.push(el("div", { className: "row stacked" }, [
        el("div", { className: "row-copy" }, [el("div", { className: "row-title", text: S("mobile.deviceName") }), el("div", { className: "row-hint", text: nameHint })]),
        el("div", { className: "inline-form" }, [
          input,
          button(S("mobile.saveName"), { tone: "primary", key: "mobile:rename", onClick: save }),
          button(S("mobile.resetName"), { key: "mobile:rename", onClick: async () => {
            const result = await mobileAction("rename", { action: "rename", reset: true });
            if (result?.ok) { draftName = null; render(); }
          } }),
        ]),
      ]));
    }
    if (companion.enrolled) {
      rows.push(settingRow({
        title: S("mobile.enable"), hint: S("mobile.enableHint"),
        control: switchControl({ checked: companion.enabled, label: S("mobile.enable"), key: "mobile:toggle",
          onChange: value => mobileAction("toggle", { action: value ? "enable" : "disable" }) }),
      }));
      rows.push(settingRow({ title: S("mobile.service"), hint: companion.relayOrigin || "—" }));
      rows.push(settingRow({ title: S("mobile.lan"), hint: companion.lanPort ? fmt("mobile.lanOn", { port: companion.lanPort }) : S("mobile.lanOff") }));
      rows.push(settingRow({
        title: S("mobile.control"), hint: S("mobile.controlHint"), disabled: !companion.enabled,
        control: switchControl({ checked: companion.controlEnabled, disabled: !companion.enabled, label: S("mobile.control"), key: "mobile:control",
          onChange: value => mobileAction("control", { action: "control", enabled: value }) }),
      }));
      rows.push(settingRow({
        title: S("mobile.testNotification"),
        control: button(S("mobile.testNotification"), { key: "mobile:test", disabled: !companion.enabled,
          onClick: async () => {
            const result = await mobileAction("test", { action: "test-notification" });
            if (result?.ok) showToast({ tone: "success", text: S("mobile.updated") });
          } }),
      }));
    }
    if (rows.length) root.append(section(S("mobile.thisComputer"), rows));

    if (companion.enrolled && companion.enabled) {
      const pairing = companion.pairing;
      const pairRows = [];
      if (!pairing) {
        pairRows.push(settingRow({
          title: S("mobile.readOnly"), hint: S("mobile.readOnlyHint"),
          control: switchControl({ checked: pairReadOnly, label: S("mobile.readOnly"), key: "pair:readonly", onChange: value => { pairReadOnly = value; render(); } }),
        }));
        pairRows.push(settingRow({
          title: S("mobile.persistent"), hint: S("mobile.persistentHint"), disabled: pairReadOnly,
          control: switchControl({ checked: pairPersistent && !pairReadOnly, disabled: pairReadOnly, label: S("mobile.persistent"), key: "pair:persistent", onChange: value => { pairPersistent = value; render(); } }),
        }));
        pairRows.push(settingRow({
          control: button(S("mobile.pair"), { tone: "primary", key: "mobile:pair", onClick: () => mobileAction("pair", {
            action: "pair",
            scopes: pairReadOnly ? ["events.read", "history.read"] : ["events.read", "history.read", "approvals.decide", "questions.answer", "reminders.dismiss", ...(pairPersistent ? ["approvals.persistent"] : [])],
          }) }),
        }));
      } else {
        const block = el("div", { className: "pairing" }, [
          el("p", { className: "row-hint", text: S("mobile.codeHint") }),
          el("output", { className: "pair-code", text: pairing.code || "" }),
          el("p", { className: "row-title", text: pairing.mobileName ? fmt("mobile.requestedBy", { name: pairing.mobileName }) : S("mobile.waitingPhone") }),
        ]);
        if (pairing.fingerprint) {
          block.append(el("output", { className: "fingerprint", text: pairing.fingerprint }));
          block.append(el("p", { className: "row-hint", text: S("mobile.compare") }));
        }
        block.append(el("div", { className: "row-actions start" }, [
          pairing.fingerprint ? button(S("mobile.confirm"), { tone: "primary", key: "mobile:confirm", onClick: () => mobileAction("confirm", { action: "confirm", fingerprint: pairing.fingerprint }) }) : null,
          button(S("mobile.cancelPair"), { key: "mobile:cancel", onClick: () => mobileAction("cancel", { action: "cancel-pair" }) }),
        ]));
        pairRows.push(block);
      }
      root.append(section(S("mobile.pairTitle"), pairRows));
    }

    const devices = (companion.bindings || []).map(device => settingRow({
      lead: icon("phone", "device-icon"),
      title: device.name || "Android",
      hint: S(device.state === "active" ? (device.scopes?.includes("approvals.decide") ? "mobile.deviceDecide" : "mobile.deviceReadOnly") : device.state === "revoked" ? "mobile.deviceRevoked" : "mobile.devicePending"),
      control: device.state !== "revoked" ? button(S("mobile.revoke"), { tone: "danger", key: `mobile:revoke:${device.bindingId}`,
        onClick: () => mobileAction(`revoke:${device.bindingId}`, { action: "revoke", bindingId: device.bindingId }) }) : null,
    }));
    if (!devices.length) devices.push(settingRow({ hint: S("mobile.noDevices") }));
    root.append(section(S("mobile.devices"), devices));
    root.append(el("p", { className: "footnote", text: S("mobile.footer") }));
  }

  // Page orchestration ----------------------------------------------------

  function render() {
    if (!state) return;
    document.documentElement.lang = state.locale === "zh-CN" ? "zh-CN" : "en-US";
    document.documentElement.dataset.theme = state.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.platform = state.platform || "";
    document.title = S("windowTitle");
    if (!["general", "history", "mobile"].includes(page) && !state.clients.some(client => client.id === page)) page = "general";
    renderSidebar();
    const scroller = document.getElementById("scroller");
    const scrollTop = scroller.scrollTop;
    const root = document.getElementById("page");
    const key = page === "history" && historyDetail ? `history:${historyDetail.id}` : page;
    const previous = root.dataset.page;
    const next = el("div", { className: "page", attrs: { id: "page", "aria-live": "polite" }, dataset: { page: key } });
    if (page === "general") renderGeneral(next);
    else if (page === "history") (historyDetail ? renderHistoryDetail : renderHistoryList)(next);
    else if (page === "mobile") renderMobile(next);
    else renderClient(next, state.clients.find(client => client.id === page));
    if (previous === key) next.style.animation = "none";
    const focused = previous === key && document.activeElement?.classList?.contains("text-input");
    root.replaceWith(next);
    scroller.scrollTop = previous === key ? scrollTop : 0;
    if (focused) {
      const input = next.querySelector(".text-input");
      input?.focus();
      input?.setSelectionRange?.(input.value.length, input.value.length);
    }
  }

  function navigate(target) {
    if (typeof target !== "string") return;
    if (target === page && !(target === "history" && historyDetail)) return;
    page = target;
    historyDetail = null;
    render();
    if (page === "history") loadHistory();
  }

  async function load() {
    try {
      const next = await api.state();
      if (!next) return;
      state = next;
      if (typeof next.initialPage === "string") {
        page = next.initialPage;
        historyDetail = null;
      }
      render();
      if (page === "history") loadHistory();
    } catch {}
  }

  for (const node of document.querySelectorAll(".nav-item[data-page]")) {
    node.addEventListener("click", () => navigate(node.dataset.page));
  }
  fillIcons();
  api.onChanged(() => load());
  api.onNavigate(target => {
    if (typeof target === "string") navigate(target);
  });
  setInterval(() => {
    if (page === "mobile" && state?.companion?.pairing && !document.hidden) mobileAction("poll", { action: "poll" }, { quiet: true });
  }, 3000);
  load();
})();
