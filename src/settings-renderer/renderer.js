"use strict";

(() => {
  const api = window.settingsAPI;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    gear: "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Zm5.5 2.4c0-.3 0-.6-.1-.9l1.4-1.1-1.4-2.4-1.7.6a5.3 5.3 0 0 0-1.5-.9L9.9 1.5H7.1l-.3 1.8c-.5.2-1 .5-1.5.9l-1.7-.6L2.2 6l1.4 1.1a5.6 5.6 0 0 0 0 1.8L2.2 10l1.4 2.4 1.7-.6c.5.4 1 .7 1.5.9l.3 1.8h2.8l.3-1.8c.5-.2 1-.5 1.5-.9l1.7.6 1.4-2.4-1.4-1.1c.1-.3.1-.6.1-.9Z",
    search: "M7 2.5a4.5 4.5 0 1 0 2.8 8l2.9 2.9.9-.9-2.9-2.9A4.5 4.5 0 0 0 7 2.5Zm0 1.3a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z",
    clock: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Zm0 1.3a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8Zm-.6 1.6v3.7l3 1.8.6-1-2.4-1.5V4.7H7.4Z",
    phone: "M5.2 1.5h5.6c.8 0 1.4.6 1.4 1.4v10.2c0 .8-.6 1.4-1.4 1.4H5.2c-.8 0-1.4-.6-1.4-1.4V2.9c0-.8.6-1.4 1.4-1.4Zm0 1.3v10.4h5.6V2.8H5.2Zm1.9 8.5h1.8v1.1H7.1v-1.1Z",
    refresh: "M8 2.2a5.8 5.8 0 0 0-5.3 3.5l1.2.5A4.5 4.5 0 0 1 11.8 5H9.6v1.3h4.2V2.1h-1.3v1.8A5.8 5.8 0 0 0 8 2.2Zm4.1 7.6A4.5 4.5 0 0 1 4.2 11h2.2V9.7H2.2v4.2h1.3v-1.8a5.8 5.8 0 0 0 9.8-1.8l-1.2-.5Z",
    folder: "M2 3.5h4.3l1.3 1.4H14v7.6H2V3.5Zm1.3 1.3v6.4h9.4V6.2H7L5.7 4.8H3.3Z",
  };

  let state = null;
  let page = "general";
  let query = "";
  let toastTimer = null;
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
      if (node.firstChild) continue;
      node.append(icon(node.dataset.icon, "").firstChild);
    }
  }

  function applyAppearance(node, appearance) {
    if (!appearance) return;
    const dark = state?.theme === "dark";
    node.style.setProperty("--agent-accent", appearance.accent);
    node.style.setProperty("--agent-ink", dark ? appearance.inkDark : appearance.inkLight);
  }

  function badge(client, large = false) {
    const node = el("span", { className: `agent-badge${large ? " large" : ""}`, text: client.appearance?.glyph || "?", attrs: { "aria-hidden": "true" } });
    applyAppearance(node, client.appearance);
    return node;
  }

  function statusLabel(status) {
    const key = { healthy: "statusHealthy", repair: "statusRepair", notDetected: "statusNotDetected", clientDisabled: "statusClientDisabled", unavailable: "statusUnavailable" }[status] || "statusOff";
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
    if (client && payload.type === "client-preference") client.preferences[payload.key] = payload.value;
  }

  async function act(key, payload) {
    if (busy.has(key)) return;
    busy.add(key);
    optimistic(payload);
    render();
    let result = null;
    try { result = await api.action(payload); }
    catch { result = null; }
    busy.delete(key);
    if (result?.state) state = result.state;
    render();
    if (result?.message) showToast(result.message);
  }

  function switchControl({ checked, disabled, label, key, onChange }) {
    const input = el("input", { attrs: { type: "checkbox", role: "switch", "aria-label": label } });
    input.checked = !!checked;
    input.disabled = !!disabled || busy.has(key);
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { className: `switch${busy.has(key) ? " busy" : ""}` }, [input, el("span")]);
  }

  function button(label, options = {}) {
    const node = el("button", {
      className: `button${options.tone ? ` ${options.tone}` : ""}`,
      attrs: { type: "button", disabled: options.disabled || (options.key && busy.has(options.key)) },
      onClick: options.onClick,
    }, [options.icon ? icon(options.icon) : null, el("span", { text: label })]);
    return node;
  }

  function settingRow({ title, hint, control, disabled, meta }) {
    return el("div", { className: `row${disabled ? " disabled" : ""}` }, [
      el("div", { className: "row-copy" }, [title ? el("div", { className: "row-title", text: title }) : null, hint ? el("div", { className: "row-hint", text: hint }) : null]),
      meta ? el("span", { className: "row-meta", text: meta }) : null,
      control,
    ]);
  }

  function section(title, children) {
    return el("section", { className: "section" }, [
      title ? el("h2", { className: "section-title", text: title }) : null,
      el("div", { className: "card" }, children),
    ]);
  }

  // Sidebar ---------------------------------------------------------------

  function clientGroups() {
    const needle = query.trim().toLowerCase();
    const clients = state.clients.filter(client => client.available || client.enabled)
      .filter(client => !needle || client.name.toLowerCase().includes(needle) || client.id.includes(needle));
    return [
      { key: "groupEnabled", items: clients.filter(client => client.enabled) },
      { key: "groupDetected", items: clients.filter(client => !client.enabled && client.detected) },
      { key: "groupOther", items: clients.filter(client => !client.enabled && !client.detected) },
    ].filter(group => group.items.length);
  }

  function renderSidebar() {
    document.getElementById("brand-version").textContent = fmt("version", { version: state.general.version });
    document.getElementById("nav-general-label").textContent = S("general");
    document.getElementById("nav-general").classList.toggle("active", page === "general");
    document.getElementById("nav-general").setAttribute("aria-current", page === "general" ? "page" : "false");
    const search = document.getElementById("search");
    search.placeholder = S("searchClients");
    search.setAttribute("aria-label", S("searchClients"));
    const nav = document.getElementById("client-nav");
    nav.setAttribute("aria-label", S("clients"));
    nav.replaceChildren();
    const groups = clientGroups();
    if (!groups.length) nav.append(el("div", { className: "nav-empty", text: S("noClientMatch") }));
    for (const group of groups) {
      const container = el("div", { className: "nav-group", attrs: { role: "group", "aria-label": S(group.key) } }, [
        el("div", { className: "nav-group-title" }, [el("span", { text: S(group.key) }), el("span", { text: String(group.items.length) })]),
      ]);
      for (const client of group.items) {
        const item = el("button", {
          className: `client-item${page === client.id ? " active" : ""}${client.enabled ? "" : " dim"}`,
          attrs: { type: "button", "aria-current": page === client.id ? "page" : "false", title: `${client.name} · ${statusLabel(client.status)}` },
          dataset: { page: client.id },
          onClick: () => navigate(client.id),
        }, [badge(client), el("span", { className: "client-name", text: client.name }), el("span", { className: "status-dot", dataset: { status: client.enabled ? client.status : "off" }, attrs: { "aria-hidden": "true" } })]);
        container.append(item);
      }
      nav.append(container);
    }
    const history = document.querySelector("#open-history .footer-label");
    history.textContent = state.general.historyCount ? fmt("recentEventsCount", { count: state.general.historyCount }) : S("recentEvents");
    document.querySelector("#open-mobile .footer-label").textContent = S("mobileCompanion");
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
    root.append(el("header", { className: "page-header" }, [
      el("div", { className: "page-header-copy" }, [el("h1", { text: S("general") }), el("p", { text: S("generalSubtitle") })]),
    ]));

    const summary = state.summary;
    root.append(el("section", { className: "section" }, [
      el("h2", { className: "section-title", text: S("sectionIntegrations") }),
      el("div", { className: "card" }, [
        el("div", { className: "summary" }, [
          el("div", { className: "stat" }, [el("strong", { text: String(summary.enabled) }), el("span", { text: S("groupEnabled") })]),
          el("div", { className: "stat" }, [el("strong", { text: String(summary.detected) }), el("span", { text: S("groupDetected") })]),
          el("div", { className: "stat" }, [el("strong", { text: String(summary.total) }), el("span", { text: S("clients") })]),
        ]),
        settingRow({
          hint: S("integrationSummaryHint"),
          control: el("div", { className: "row-actions" }, [
            button(S("rescan"), { icon: "refresh", key: "rescan", onClick: () => act("rescan", { type: "rescan" }) }),
            button(S("repairAll"), { key: "repair-all", disabled: !summary.enabled, onClick: () => act("repair-all", { type: "repair-all" }) }),
          ]),
        }),
      ]),
    ]));

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

  const TRANSPORT_KEYS = {
    "command-hook": "transportCommandHook",
    "python-plugin": "transportPythonPlugin",
    "reverse-bridge": "transportReverseBridge",
    "cordis-plugin": "transportCordisPlugin",
    extension: "transportExtension",
    plugin: "transportPlugin",
  };

  function renderClient(root, client) {
    const agentName = client.name;
    const tierKey = { approval: "tierApproval", passive: "tierPassive" }[client.tier] || "tierStatus";
    const chips = el("div", { className: "chips" }, [
      el("span", { className: "chip", text: S(tierKey) }),
      el("span", { className: "chip", text: S(TRANSPORT_KEYS[client.transport] || "transportCommandHook") }),
    ]);
    root.append(el("header", { className: "page-header" }, [
      badge(client, true),
      el("div", { className: "page-header-copy" }, [
        el("div", { className: "title-line" }, [
          el("h1", { text: agentName }),
          el("span", { className: "pill", dataset: { status: client.status } }, [el("span", { className: "status-dot" }), el("span", { text: statusLabel(client.status) })]),
        ]),
        chips,
      ]),
    ]));

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

    if (client.enabled && client.codex?.featureDisabled) {
      root.append(el("div", { className: "notice" }, [
        el("p", { text: S("codexFeatureOff") }),
        button(S("codexEnableFeature"), { key: "codex-enable-feature", onClick: () => act("codex-enable-feature", { type: "codex-enable-feature" }) }),
      ]));
    } else if (client.enabled && client.codex?.trustPending) {
      root.append(el("div", { className: "notice" }, [
        el("p", { text: S("codexTrustPending") }),
        button(S("copyHooks"), { onClick: () => act("codex-copy-review", { type: "codex-copy-review" }) }),
      ]));
    }
    if (client.enabled && client.reason && (client.status === "repair" || client.status === "clientDisabled")) {
      root.append(el("div", { className: "notice error" }, [
        el("p", { text: client.reason }),
        button(S("repair"), { key: `repair:${client.id}`, onClick: () => act(`repair:${client.id}`, { type: "client-repair", agentId: client.id }) }),
      ]));
    }

    const supported = FEATURE_ROWS.filter(row => client.features[row.key]);
    const featureRows = supported.map(row => {
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
    const featureSection = section(fmt("sectionFeatures", { agentName }), featureRows);
    if (!client.enabled) {
      featureSection.querySelector(".card").prepend(el("div", { className: "row" }, [
        el("div", { className: "row-copy" }, [el("div", { className: "row-hint", text: fmt("enableToConfigure", { agentName }) })]),
      ]));
    }
    root.append(featureSection);

    const detection = client.executable ? S("detectionExecutable") : (client.detected ? S("detectionConfig") : S("detectionNone"));
    const verification = { live: "verificationLive", contract: "verificationContract" }[client.verification] || "verificationNone";
    const kv = (label, value) => el("div", { className: "kv" }, [el("dt", { text: label }), el("dd", {}, [].concat(value))]);
    const paths = el("div", { className: "paths" }, client.configPaths.length
      ? client.configPaths.map(item => el("span", { className: "path", text: item }))
      : [el("span", { className: "path", text: "—" })]);
    const rows = [
      kv(S("rowDetection"), el("span", { text: detection })),
      kv(S("rowHook"), el("span", { text: client.installed ? S("hookInstalled") : S("hookMissing") })),
      kv(S("rowVerification"), el("span", { text: S(verification) })),
      kv(S("rowConfig"), paths),
    ];
    if (client.enabled && client.reason) rows.push(kv(S("rowReason"), el("span", { text: client.reason })));
    const card = el("dl", { className: "card" }, rows);
    const actions = el("div", { className: "row-actions" }, [
      button(S("openConfig"), { icon: "folder", disabled: !client.configPaths.length, onClick: () => act(`open:${client.id}`, { type: "client-open-config", agentId: client.id }) }),
      button(S("repair"), { icon: "refresh", key: `repair:${client.id}`, disabled: !client.enabled, onClick: () => act(`repair:${client.id}`, { type: "client-repair", agentId: client.id }) }),
    ]);
    root.append(el("section", { className: "section" }, [el("h2", { className: "section-title", text: S("sectionStatus") }), card, actions]));
  }

  // Page orchestration ----------------------------------------------------

  function render() {
    if (!state) return;
    document.documentElement.lang = state.locale === "zh-CN" ? "zh-CN" : "en-US";
    document.documentElement.dataset.theme = state.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.platform = state.platform || "";
    document.title = S("windowTitle");
    if (page !== "general" && !state.clients.some(client => client.id === page)) page = "general";
    renderSidebar();
    const scroller = document.getElementById("scroller");
    const scrollTop = scroller.scrollTop;
    const root = document.getElementById("page");
    const previous = root.dataset.page;
    const next = el("div", { className: "page", attrs: { id: "page", "aria-live": "polite" }, dataset: { page } });
    if (page === "general") renderGeneral(next);
    else renderClient(next, state.clients.find(client => client.id === page));
    if (previous === page) next.style.animation = "none";
    root.replaceWith(next);
    scroller.scrollTop = previous === page ? scrollTop : 0;
  }

  function navigate(target) {
    if (typeof target !== "string" || target === page) return;
    page = target;
    render();
  }

  async function load() {
    try {
      const next = await api.state();
      if (!next) return;
      state = next;
      if (typeof next.initialPage === "string") page = next.initialPage;
      render();
    } catch {}
  }

  document.getElementById("nav-general").addEventListener("click", () => navigate("general"));
  document.getElementById("open-history").addEventListener("click", () => act("open-history", { type: "open-history" }));
  document.getElementById("open-mobile").addEventListener("click", () => act("open-mobile", { type: "open-mobile" }));
  document.getElementById("search").addEventListener("input", event => {
    query = event.target.value.slice(0, 80);
    renderSidebar();
  });
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      document.getElementById("search").focus();
    }
  });
  fillIcons();
  api.onChanged(() => load());
  api.onNavigate(target => {
    if (typeof target === "string") navigate(target);
  });
  load();
})();
