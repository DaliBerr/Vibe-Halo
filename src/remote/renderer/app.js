"use strict";
const t = window.companionText;
const $ = id => document.getElementById(id);
let state = {}, busy = false;
const errors = { secure_storage_unavailable: "系统安全存储不可用，无法保存设备身份。", capacity_exceeded: "服务暂时已满，稍后会自动重试。", registration_closed: "服务暂时停止接入新电脑，稍后会自动重试。", rate_limited: "连接过于频繁，稍后会自动重试。", device_revoked: "此电脑已被服务撤销。", identity_conflict: "设备身份冲突，请检查本机配置。", pairing_expired: "配对已过期，请生成新配对码。" };
const statuses = { ...errors, connecting: "正在连接…", disabled: "未开启", connected: "已连接", offline: "云端离线", lan_unavailable: "局域网不可用", revocation_pending_cloud: "等待云端撤销", secure_storage_unavailable: "系统安全存储不可用", credential_store_invalid: "设备凭据损坏", remote_journal_invalid: "事件记录损坏" };
async function act(input, quiet = false) {
  if (busy) return;
  busy = true;
  try { const result = await window.mobileSettings.action(input); if (result.error) { if (!quiet) $("message").textContent = t(errors[result.error] || "操作未完成，请检查服务连接后重试。"); } else { render(result); if (!quiet) $("message").textContent = t("已更新"); } }
  finally { busy = false; }
}
function render(value) {
  window.applyCompanionLanguage(value.locale);
  state = value; $("status").textContent = t(statuses[value.status] || value.status);
  const configured = value.enrolled === true;
  $("setup").hidden = configured; $("configured").hidden = !configured;
  $("retry").disabled = value.status === "connecting";
  $("service").textContent = value.relayOrigin; $("lan").textContent = value.lanPort ? `${t("局域网服务已开启 · 端口")} ${value.lanPort}` : t("局域网服务未开启");
  $("toggle").textContent = t(value.enabled ? "关闭手机伴侣" : "开启手机伴侣");
  $("testNotification").disabled = !value.enabled;
  $("control").checked = value.controlEnabled; $("control").disabled = !value.enabled;
  $("pairSection").hidden = !value.enabled; $("pairing").hidden = !value.pairing;
  $("code").textContent = value.pairing?.code || ""; $("fingerprint").textContent = value.pairing?.fingerprint || "";
  $("phone").textContent = value.pairing?.mobileName ? `${t("申请连接：")}${value.pairing.mobileName}` : t("等待手机输入配对码…");
  $("compare").hidden = $("confirm").hidden = !value.pairing?.fingerprint;
  $("devices").replaceChildren();
  for (const device of value.bindings) {
    const row = document.createElement("div"); row.className = "device";
    const text = document.createElement("div"), name = document.createElement("strong"), status = document.createElement("p");
    name.textContent = device.name || "Android"; status.textContent = t(device.state === "active" ? (device.scopes.includes("approvals.decide") ? "已连接 · 可提交决定" : "已连接 · 只读") : device.state === "revoked" ? "已撤销" : "等待确认");
    text.append(name, status); row.append(text);
    if (device.state !== "revoked") { const button = document.createElement("button"); button.className = "danger"; button.textContent = t("撤销"); button.onclick = () => act({ action: "revoke", bindingId: device.bindingId }); row.append(button); }
    $("devices").append(row);
  }
  if (!value.bindings.length) { const empty = document.createElement("p"); empty.textContent = t("还没有连接的手机。"); $("devices").append(empty); }
}
$("setup").onsubmit = async event => { event.preventDefault(); await act({ action: "configure" }, true); };
$("toggle").onclick = () => act({ action: state.enabled ? "disable" : "enable" });
$("control").onchange = event => act({ action: "control", enabled: event.target.checked });
$("pair").onclick = () => act({ action: "pair", scopes: $("readOnly").checked ? ["events.read", "history.read"] : ["events.read", "history.read", "approvals.decide", "questions.answer", "reminders.dismiss", ...($("persistent").checked ? ["approvals.persistent"] : [])] });
$("confirm").onclick = () => act({ action: "confirm", fingerprint: state.pairing?.fingerprint });
$("cancelPair").onclick = () => act({ action: "cancel-pair" });
$("testNotification").onclick = () => act({ action: "test-notification" });
window.mobileSettings.onChanged(render);
setInterval(() => { if (state.pairing && !document.hidden) act({ action: "poll" }, true); }, 3000);
act({ action: "status" }, true);
