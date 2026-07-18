# Vibe Halo 项目交接

更新时间：2026-07-18  
当前版本：`0.1.5`  
当前源码目录：`C:\Tools\Clawd-island`

## 1. 当前结论

Vibe Halo 已从 Clawd on Desk 中拆出为独立 Electron 应用，第一阶段仅支持 Windows 上的 Codex。它不包含桌宠、多 Agent、远程审批、主题系统、自动更新或原工程的 JSONL 状态机。

当前可用能力：

- 接管 Codex 官方 `PermissionRequest` Hook，在屏幕顶部显示审批灵动岛并把允许/拒绝结果返回 Codex。
- 接收 `Stop` 和 `UserPromptSubmit`，显示或清理完成通知。
- 只读监控 Codex session JSONL 中的 `request_user_input`，显示等待输入提醒；实际选项仍在 Codex 原生界面回答。
- 单窗口、透明无边框、始终置顶、不抢初始焦点；点击后展开并激活。
- 展开窗口采用 220ms ease-out 尺寸动画，内容同步执行淡入/位移动画，并尊重系统减少动画设置。
- 托盘提供审批开关、等待输入提醒、开机启动、Hook 修复、诊断、卸载集成和退出。
- 改名前曾产出 `dist/Clawd-Island-Setup-0.1.5-x64.exe`；新构建产物命名为 `Vibe-Halo-Setup-<version>-x64.exe`。

## 2. 已完成实现

### Codex Hook 与安全回退

- 管理 `~/.codex/hooks.json` 中的 `PermissionRequest`、`Stop`、`UserPromptSubmit`。
- 首次接管会备份配置，迁移旧 Clawd `codex-hook.js` 和旧 `clawd-island-hook.js`，保留第三方 Hook；修复操作幂等。
- 不覆盖显式的 `hooks=false`，必须由用户在托盘确认启用。
- Codex 新版 Hook 信任仍需用户在 Codex 输入 `/hooks` 后手动审核，应用不会绕过官方信任机制。
- 本地 HTTP 服务仅监听 `127.0.0.1` 的系统分配端口；每次启动生成随机令牌并原子写入 `~/.vibe-halo/runtime.json`。
- 服务离线、令牌非法、请求超限、异常、关闭窗口和 120 秒超时均返回 `{}`，交还 Codex 原生审批，不会自动拒绝。
- Renderer 使用上下文隔离、禁用 Node、禁止导航和新窗口；审批、关闭、复制和尺寸 IPC 均校验当前项目 ID、类型及长度。

### 审批和多 Session

- 所有 Codex Session 的审批进入一个全局 FIFO，单个灵动岛一次只展示一项。
- 使用 `session_id + tool_use_id` 去重；无 `tool_use_id` 时使用输入指纹。同一请求的多个 HTTP 连接共享最终决定。
- 当前审批结束后，下一项重新以收起态显示，避免连续误批，并根据新请求的 PID 链重新定位屏幕。
- 子代理或 headless 审批直接返回无决策，不显示灵动岛。
- 等待输入提醒同样是全局 FIFO，以 `rollout 文件路径 + call_id` 去重；对应 `function_call_output` 到达后只清除匹配提醒。
- UI 总优先级为：审批 > 等待输入 > 完成通知。

### 灵动岛 UI

- 移除了整块 Windows Acrylic，BrowserWindow 使用真正透明背景，卡片自身绘制深色/浅色表面、圆角、边框和阴影。
- 收起卡片保持约 `300×52`，透明窗口以 `348×88` DIP 为其阴影预留左右和底部渐隐空间；展开态窗口根据 Renderer 测量在约 `608～808 × 356～636` DIP 内钳制，并受当前工作区限制。
- 展开布局为标题、说明、可滚动内容、固定操作栏；长命令、高 DPI 和较矮工作区不会再把按钮挤出窗口。
- 命令、补丁、查询、路径等使用人类可读布局；额外参数放在默认收起的“查看完整参数”中，不再默认展示大段 JSON。
- 展开、收起和点击切换已加入窗口 bounds 动画；新审批切换时重置为收起态。
- 定位优先使用请求 PID 链对应的可见顶层窗口所在屏幕，其次鼠标屏幕，最后主屏幕；显示器变化时重新定位。

### 完成通知和等待输入

- `Stop` 通知收起时 8 秒自动关闭；点击展开后停止自动关闭，用户手动关闭。
- `UserPromptSubmit` 只清除同 Session 的完成通知和等待输入提醒。
- `request_user_input` 不是官方 Hook 事件，目前通过只读增量扫描 `~/.codex/sessions/**/rollout-*.jsonl` 检测。
- 提醒中可展示问题和三选一等选项，但不能在灵动岛内作答；用户仍需回到 Codex 原生输入界面。

## 3. 架构入口

```text
Codex official Hook
  ├─ PermissionRequest ─> loopback /permission ─> ApprovalStore ─> IslandController ─> 用户决定 ─> Hook stdout ─> Codex
  └─ Stop/UserPromptSubmit ─> loopback /event ─> CompletionStore / session cleanup

Codex rollout JSONL ─> CodexInputMonitor ─> InputRequestStore ─> IslandController ─> 只读提醒
```

关键文件：

- `src/main.js`：应用生命周期、托盘、各 Store 和服务装配。
- `hooks/vibe-halo-hook.js`：自包含 Codex Hook、payload 归一化和 fail-open 输出。
- `src/server.js`：带进程令牌的 loopback 服务。
- `src/approval-store.js`：审批 FIFO、去重、连接、超时和幂等解析。
- `src/codex-input-monitor.js`：等待输入的多 session JSONL 增量监控。
- `src/input-request-store.js`：等待输入 FIFO 和按 Session 清理。
- `src/completion-store.js`：完成通知生命周期。
- `src/island-controller.js`：单 BrowserWindow、优先级、定位、受限 IPC 和尺寸动画。
- `src/renderer/`：原生 HTML/CSS/JS 卡片 UI。
- `src/hook-manager.js`：Hook 安装、备份、迁移、信任健康检查和卸载恢复。

## 4. 当前验证状态

- 2026-07-18 在 Windows 开发机运行 `npm test`：53/53 通过，0 失败。
- 自动测试已覆盖 Hook 合并与迁移、Codex 精确输出、离线与非法令牌、审批 FIFO/去重/断连/超时、等待输入识别与清理、完成通知、IPC 校验、尺寸钳制、动画插值和屏幕回退。
- 用户已经真实看到审批灵动岛，并确认 0.1.4 重做后的圆角、尺寸、内容布局和按钮问题正常。
- 0.1.5 已实现展开动画并完成自动测试及打包；动画主观效果尚未在本会话中收到最终人工验收结论。
- `dist/` 中保留了 0.1.0～0.1.5 的历史 x64 NSIS 包，迁移源码时不是必需内容。

## 5. 已知限制与优先技术债

1. **仅支持 Codex**：服务会拒绝非 `agent_id=codex` 的事件，没有 Claude Code、Gemini、Copilot、Cursor 等适配。
2. **完成通知是全局单槽**：多个 Session 连续完成时，后一个会替换前一个；存在审批或等待输入时，完成通知会被抑制而不是排队。
3. **审批超时从入队开始**：后排审批也在消耗 120 秒，队列很长时可能尚未展示就超时回退 Codex。
4. **单一全局队列**：多个 Session 不并行显示，也没有 Session 分组、轮询公平性或通知中心历史。
5. **Session 降级标识**：正常使用 `codex:<session_id>`；缺失时哈希 transcript 路径；两者都缺失会落到 `codex:unknown`，极端情况下可能发生归类碰撞。
6. **等待输入只能提醒**：Codex 当前没有可供此应用安全接管 `request_user_input` 回答的官方 command Hook，不能从灵动岛提交选项。
7. **人工平台验收仍应补齐**：多显示器、100/125/150% DPI、顶部任务栏、睡眠恢复、Explorer 重启、安装升级覆盖和卸载流程需要在独立项目中继续建立验收记录。

## 6. 迁移和接手步骤

### Git 状态

子目录已有独立 `.git`，分支名为 `main`，但**当前没有任何提交**；截至交接时，源码、测试、许可证和本交接文件均为未跟踪文件。这是迁移前最重要的事项。

推荐迁移顺序：

1. 从托盘退出正在运行的 Vibe Halo，避免移动时开发进程仍占用源码。
2. 移动项目目录时务必连同隐藏的 `.git` 一起移动。
3. 可以不迁移 `node_modules/`、`dist/` 和 `.smoke/`；它们已在 `.gitignore` 中。若需要保留改名前安装包，单独保存 `dist/Clawd-Island-Setup-0.1.5-x64.exe`。
4. 在新路径执行 `npm install`、`npm test`、`npm run build`。
5. 启动新构建后，从托盘执行“修复 Codex Hook”，确保 `~/.codex/hooks.json` 不再引用旧开发目录；随后在 Codex 输入 `/hooks` 审核新命令路径。
6. 真实测试一次允许、拒绝、关闭回退、超时回退、完成通知和 `request_user_input` 提醒。
7. 检查 `git status` 后建立首次基线提交，再开始后续开发。

移动源码目录不会自动卸载已经安装到 Program Files 的应用，也不会自动删除 `%APPDATA%\Vibe Halo`、`~/.vibe-halo`、改名前的 Clawd Island 数据或 Codex Hook。是否保留这些运行时状态应由迁移后的安装/卸载流程决定。

## 7. 开发和发布命令

```powershell
npm install
npm test
npm start
npm run build:dir
npm run build
```

- Electron：41
- 模块体系：CommonJS
- 打包：electron-builder，Windows x64 NSIS
- App ID：`com.vibe.halo`
- 数据目录：`%APPDATA%\Vibe Halo`
- 运行时目录：`~/.vibe-halo`
- 许可证：`AGPL-3.0-only`

迁移和发布时必须保留 `LICENSE`、`NOTICE.md` 以及原项目 Clawd on Desk 的版权归属。
