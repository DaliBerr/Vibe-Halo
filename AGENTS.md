# AGENTS.md

始终使用中文，称呼用户为“老大”。开始开发前先阅读 `HANDOFF.md` 和 `README.md`。

## 项目定位

Vibe Halo 是 Windows-first 的 Codex 灵动岛应用，当前仅支持 Codex。它接管审批、显示完成通知，并只读提醒 `request_user_input`；不包含桌宠、其他 Agent、远程审批、主题系统或自动更新。除非用户明确要求，不要把原 Clawd on Desk 的多 Agent 和桌宠代码搬回来。

## 常用命令

```powershell
npm install
npm test
npm start
npm run build:dir
npm run build
```

自动测试使用 Node 内置 test runner。行为改动必须运行 `npm test`；窗口、透明度、焦点、动画、多屏/DPI 和 NSIS 流程还需要 Windows 人工验收。

## 代码入口

- `src/main.js`：Electron 生命周期、托盘、Store 与服务装配。
- `hooks/vibe-halo-hook.js`：Codex 官方 Hook、请求归一化和 stdout 决策输出。
- `src/server.js`：仅监听 loopback、校验启动令牌并接收 Hook。
- `src/approval-store.js`：审批 FIFO、去重、超时、断连和幂等决策。
- `src/codex-input-monitor.js`：只读增量监控 Codex session JSONL。
- `src/input-request-store.js` / `src/completion-store.js`：提醒和完成通知生命周期。
- `src/island-controller.js`：单 BrowserWindow、事件优先级、定位、IPC、尺寸与动画。
- `src/renderer/`：原生 HTML/CSS/JS UI；Renderer 不得直接访问 Node。
- `src/hook-manager.js`：Hook 安装、备份、迁移、健康检查和安全卸载。
- `test/`：协议、Store、服务器、Hook、IPC、定位和窗口尺寸测试。

## 不可破坏的约束

- Codex 审批只有显式“允许”或“拒绝”才能产生决定；关闭、断线、异常、非法响应和超时必须返回 `{}`，让 Codex 原生审批接管。
- Hook stdout 只能输出经过净化的 Codex 决策 JSON，不能输出日志；Hook 保持自包含，只依赖 Node 内置模块。
- 本地服务只监听 `127.0.0.1`，每次启动生成新令牌；不得记录令牌或完整命令内容。
- 保留 256 KiB 请求上限、IPC 类型/长度/当前 ID 校验、上下文隔离、禁用 Node、禁止导航和新窗口。
- Hook 安装只能增量合并：保留第三方配置，备份首次状态，只接管自身及迁移记录中的旧 Vibe Halo / Clawd Codex Hook。`hooks=false` 不得静默覆盖。
- 所有 Session 共用单一审批 FIFO；必须以显式审批 ID 响应。新队首项重新收起，避免错批。
- UI 优先级固定为审批 > 等待输入 > 完成通知；`request_user_input` 目前只能提醒，不能代替用户回答。
- 窗口初次出现使用 `showInactive()`，不抢焦点；用户点击后才允许激活。操作栏必须在长内容、高 DPI 和矮工作区下保持可见。
- 许可证保持 `AGPL-3.0-only`，发布时必须包含 `LICENSE`、`NOTICE.md` 和上游版权归属。

## 修改原则

- 保持 CommonJS、Electron 41、原生 HTML/CSS/JS 和单窗口架构。
- 优先把纯逻辑放进可测试模块；协议、队列、超时、IPC、尺寸或 Hook 配置变化必须补回归测试。
- 不提交 `node_modules/`、`dist/`、`.smoke/` 或日志。
- Windows 打包使用 x64 NSIS，产物名保留明确版本和架构。
- 若移动源码目录或改变安装路径，启动新构建后执行“修复 Codex Hook”，并提示用户在 Codex `/hooks` 中重新审核命令路径。

## Git 操作规则

- `main` 只保留已确认合并的稳定内容，不直接在 `main` 上开展日常开发。
- 每次开发前先同步本地基线，并从 `main` 创建新的 `codex/<简短任务名>` 分支；一个分支只承载一项明确任务。
- 提交前检查 `git status` 和完整 diff，只暂存本次任务相关文件；不得提交 `node_modules/`、`dist/`、`.smoke/`、日志、密钥或本机运行时数据。
- 行为改动至少运行 `npm test`；涉及窗口、DPI、动画、Hook 安装或 NSIS 时补充对应人工验收，并在交付说明中记录结果。
- 提交信息应简短明确、描述实际改动；未经用户明确授权，不得改写公开历史、强制推送或删除远端分支。
- 开发完成后先提交并推送当前开发分支，汇报分支、提交、验证结果和差异摘要，然后询问老大是否合并。
- 只有老大明确同意后，才可把开发分支合并进 `main`；合并后再按要求推送 `main`，不得擅自创建或合并 Pull Request。
