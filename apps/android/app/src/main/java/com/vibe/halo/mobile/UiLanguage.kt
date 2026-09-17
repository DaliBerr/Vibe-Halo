package com.vibe.halo.mobile

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

object UiLanguage {
    var mode by mutableStateOf("system")
    private val english = mapOf(
        "已连接" to "Connected", "当前请求" to "Current request", "排队或等待原生处理" to "Queued or awaiting the original client", "项待处理" to "pending", "剩余" to "Time left",
        "查看事件" to "Read events", "读取历史" to "Read history", "提交审批" to "Decide approvals", "精确回答" to "Answer questions", "关闭提醒" to "Dismiss reminders", "长期授权" to "Persistent permissions", "正在读取。电脑需要在线。" to "Loading. Your computer must be online.",
        "审批提醒" to "Approval reminders",
        "输入与回答提醒" to "Input and question reminders",
        "完成与计划就绪" to "Completions and plans",
        "连接状态" to "Connection status",
        "打开 Vibe Halo 查看最新状态" to "Open Vibe Halo for the latest status",
        "有一个请求等待查看" to "A request needs your attention",
        "客户端正在等待输入" to "Your client is waiting for input",
        "计划已准备好" to "Your plan is ready",
        "任务已完成" to "Task completed",
        "关闭这条提醒" to "Dismiss this reminder",
        "已关闭提醒，客户端仍等待你输入。" to "Reminder dismissed. The client still needs your input.",
        "本机偏好已保存，云端将在恢复连接后同步。" to "Saved on this phone. Cloud preferences will sync when connected.",
        "本机已移除权限。云端撤销将在恢复连接后重试，离线电脑可能尚未确认。" to "Removed on this phone. Cloud revocation will retry when connected; an offline computer may not know yet.",
        "云端已撤销。电脑收到撤销后，局域网权限也会关闭；离线电脑可能尚未确认。" to "Revoked in the cloud. LAN access closes when the computer learns this; offline computers may not know yet.",
        "事件详情" to "Event details",
        "读取电脑历史" to "Load computer history", "只读记录" to "Read-only record", "台电脑在线" to "computer(s) online", "已连接 · 局域网" to "Connected · Local network", "已连接 · 云端" to "Connected · Cloud",
        "此刻" to "Now", "历史" to "History", "设备" to "Devices", "刷新" to "Refresh", "连接电脑" to "Connect a computer",
        "掌握此刻。" to "Stay in the loop.", "每一步，都有记录。" to "A record of every step.", "你的工作，随身连接。" to "Your work, within reach.",
        "重要的请求，在这里等你。" to "The requests that matter, waiting here.", "最近 24 小时的状态，清楚可查。" to "Updates from the past 24 hours.", "免账号配对，电脑掌握最终权限。" to "No account. Your computer stays in control.",
        "先连接你的电脑" to "Connect your first computer", "此刻，没有待处理的请求" to "You're all caught up", "保持专注，新的进展会出现在这里。" to "Stay focused. New updates will appear here.",
        "查看详情  →" to "View details  →", "＋ 连接另一台电脑" to "+ Connect another computer", "允许系统通知" to "Allow notifications",
        "通知只提示查看；批准和回答只在详情页提交。手表使用系统通知镜像。" to "Notifications only open details. Decisions happen in the app. Watches mirror system notifications.",
        "此构建尚未配置推送服务，当前可在前台同步。" to "Push is not configured in this build. Foreground sync is available.",
        "← 返回" to "← Back", "连接，从信任开始。" to "Connection starts with trust.",
        "在电脑托盘打开「手机伴侣」，生成配对码后填在这里。" to "Open Mobile companion in your computer's tray menu, generate a pairing code, then enter it here.",
        "使用自建服务" to "Use a self-hosted service", "收起自建服务设置" to "Hide self-hosted settings",
        "中继服务地址" to "Relay address", "一次性配对码" to "One-time pairing code", "核对设备" to "Verify device", "两端指纹" to "Compare on both devices",
        "电脑已确认。指纹一致后，完成绑定。" to "Your computer confirmed. Compare the fingerprints to finish.", "请在电脑上核对同样的指纹并确认。" to "Compare this fingerprint on your computer and confirm.",
        "指纹一致，完成绑定" to "Fingerprints match · Finish", "等待电脑确认…" to "Waiting for computer…", "刷新状态" to "Refresh status",
        "等待审批" to "Approval requested", "等待回答" to "Answer requested", "等待原生输入" to "Input needed in client", "计划已就绪" to "Plan ready", "任务已完成" to "Task finished",
        "事件详情" to "Event details", "详情有省略或脱敏，当前不能从这里授权。" to "Some context is omitted or redacted. Remote approval is unavailable.",
        "补充回答" to "Your answer", "这类输入需要回到原客户端回答。" to "Answer this request in the original client.",
        "当前只读：请刷新状态，或回到电脑处理。" to "Read-only. Refresh or handle this on your computer.", "允许这一次" to "Allow once", "拒绝" to "Deny", "提交回答" to "Submit answers", "回到客户端处理" to "Handle in client",
        "事件已过期 · 仅供查看" to "Event expired · Read-only", "事件已结束 · 仅供查看" to "Event ended · Read-only",
        "查看长期授权范围…" to "Review persistent permission…", "查询 / 重试上次提交" to "Check / retry previous submission", "确认长期授权范围" to "Confirm persistent permission",
        "这项规则可能影响后续请求。请核对完整范围。" to "This rule can affect future requests. Review its full scope.", "我已核对完整范围" to "I reviewed the entire scope", "确认授权" to "Confirm permission", "取消" to "Cancel",
        "电脑历史 · 只读" to "Computer history · Read-only", "正在读取。电脑需要在线。" to "Loading. Your computer must be online.", "关闭" to "Close",
        "已撤销" to "Revoked", "离线 · 仅供查看" to "Offline · Read-only", "静音" to "Mute", "恢复提醒" to "Unmute", "撤销" to "Revoke", "撤销连接？" to "Revoke connection?",
        "清除手机上的相关缓存。离线电脑收到撤销后，局域网权限才会关闭。" to "Related phone caches will be cleared. An offline computer must receive the revocation before local-network access ends.",
        "权限：事件、历史、提交决定" to "Events, history and decisions", "权限：只读" to "Read-only access", "跟随系统" to "System language",
        "已读取电脑历史" to "Computer history loaded", "配对完成" to "Paired", "请在电脑上核对指纹并确认。" to "Compare the fingerprint on your computer and confirm.",
        "电脑已确认。请再次核对两端指纹。" to "Your computer confirmed. Check both fingerprints again.",
        "电脑已接受决定；客户端是否执行仍以客户端为准。" to "Your computer accepted the decision. Check the client for execution status.",
        "电脑离线，尚未执行。可用相同请求重试。" to "Your computer is offline. Nothing was executed; retry the same request.", "已送达中继，等待电脑回执。" to "Relay received. Waiting for your computer's receipt.",
        "请求已过期，请回到客户端处理。" to "Request expired. Continue in the original client.", "电脑未开启远程控制，或当前设备没有这项权限。" to "Remote control is disabled or this device lacks permission.",
        "请求已变化，请刷新后重新查看。" to "The request changed. Refresh and review it again.", "配对码无效或已经使用，请在电脑上生成新配对码。" to "Code invalid or already used. Generate a new code on your computer.",
        "配对已过期，请重新配对。" to "Pairing expired. Start again.", "当前详情已失效或电脑离线，请先刷新。" to "Details are stale or your computer is offline. Refresh first.",
        "设备权限已撤销，或没有这项操作权限。" to "Access was revoked or this operation is not permitted.", "操作未完成，请检查连接后重试。" to "Operation incomplete. Check the connection and retry.",
        "通知已允许" to "Notifications allowed", "仍可在应用内查看请求" to "Requests remain available in the app"
    )
    fun resolvedLocale(): String = if (mode == "zh-CN" || mode == "system" && Locale.getDefault().language == "zh") "zh-CN" else "en-US"
    fun text(value: String): String = if (resolvedLocale() == "zh-CN") value else english[value] ?: value
}
fun tr(value: String): String = UiLanguage.text(value)
