"use strict";
(() => {
  const strings = {
    "让进度，随身可见。": "Your progress, within reach.",
    "手机查看请求与完成提醒，电脑负责核验每一个决定。": "View requests and updates on your phone. Your computer verifies every decision.",
    "这台电脑": "This computer", "未开启": "Disabled", "电脑名称": "Computer name", "我的电脑": "My computer",
    "正在自动连接手机伴侣服务，连接后即可配对手机。": "Connecting automatically. Pair your phone once connected.",
    "重新连接": "Reconnect", "正在连接…": "Connecting…",
    "连接并开启手机伴侣": "Connect and enable companion", "关闭手机伴侣": "Disable companion", "开启手机伴侣": "Enable companion",
    "允许手机提交审批和精确回答": "Allow phone decisions and exact answers",
    "默认关闭。长期授权还需单独授予权限并在手机核对完整范围。通知上不会出现批准按钮。": "Off by default. Persistent permissions require a separate grant and full scope review on the phone. Notifications have no approval buttons.",
    "发送测试提醒": "Send test reminder", "连接手机": "Connect a phone", "生成配对码": "Generate pairing code",
    "只读配对（仅查看事件和历史）": "Read-only pairing (events and history)",
    "允许此手机在核对完整范围后提交长期授权": "Allow persistent permissions after full scope review on this phone",
    "在 Android 应用输入下方配对码，有效期 5 分钟。": "Enter this code in Android. Expires in 5 minutes.",
    "请与手机上显示的指纹逐字核对，一致后确认。": "Compare every fingerprint group on your phone, then confirm.",
    "指纹一致，确认连接": "Fingerprints match — confirm", "取消配对": "Cancel pairing", "已连接设备": "Connected devices",
    "还没有连接的手机。": "No phones connected yet.",
    "私钥保存在系统安全存储中。关闭此功能不会影响电脑原有的审批流程。": "Private keys stay in system secure storage. Disabling the companion preserves your local approval workflow.",
    "已连接": "Connected", "云端离线": "Cloud offline", "局域网不可用": "LAN unavailable", "等待云端撤销": "Cloud revocation pending",
    "系统安全存储不可用": "Secure storage unavailable", "设备凭据损坏": "Device credentials damaged", "事件记录损坏": "Event journal damaged",
    "服务暂时已满，稍后会自动重试。": "Service capacity reached. Retrying automatically later.",
    "服务暂时停止接入新电脑，稍后会自动重试。": "New connections are temporarily paused. Retrying automatically later.",
    "连接过于频繁，稍后会自动重试。": "Too many connection attempts. Retrying automatically later.",
    "此电脑已被服务撤销。": "This computer has been revoked by the service.",
    "设备身份冲突，请检查本机配置。": "Device identity conflict. Check this computer's configuration.",
    "系统安全存储不可用，无法保存设备身份。": "System secure storage is unavailable; identity cannot be saved.",
    "已有服务身份，请先在原服务撤销设备。": "An identity already exists. Revoke it in the original relay first.",
    "设备数量已达到服务上限。": "The relay's device capacity has been reached.", "配对已过期，请生成新配对码。": "Pairing expired. Generate a new code.",
    "操作未完成，请检查服务连接后重试。": "Operation incomplete. Check the relay connection and retry.", "已更新": "Updated",
    "局域网服务未开启": "LAN listener disabled", "局域网服务已开启 · 端口": "LAN listener active · port",
    "申请连接：": "Connection requested by: ", "等待手机输入配对码…": "Waiting for your phone…",
    "已连接 · 可提交决定": "Connected · decisions enabled", "已连接 · 只读": "Connected · read-only", "已撤销": "Revoked", "等待确认": "Awaiting confirmation", "撤销": "Revoke"
  };
  let english = false;
  const text = value => english ? strings[value] || value : value;
  const nodes = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { const node = walker.currentNode; if (strings[node.textContent.trim()]) nodes.push([node, node.textContent.trim()]); }
  window.companionText = text;
  window.applyCompanionLanguage = locale => {
    english = locale === "en-US"; document.documentElement.lang = english ? "en" : "zh-CN";
    for (const [node, value] of nodes) if (node.isConnected) node.textContent = text(value);
    document.title = english ? "Vibe Halo · Mobile companion" : "Vibe Halo · 手机伴侣";
  };
})();
