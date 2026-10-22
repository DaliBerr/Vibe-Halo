package com.vibe.halo.mobile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibe.halo.mobile.data.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun eventTime(value: String): String = runCatching { displayTime(Instant.parse(value).toEpochMilli()) }.getOrDefault("")
private fun displayTime(value: Long): String = if (value <= 0) "" else DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(value))
fun historyKind(kind: String) = when(kind) { "approval" -> "审批"; "question" -> "问答"; "input" -> "回到电脑处理"; "plan" -> "计划"; "completion" -> "任务"; else -> "事件" }
private fun heading(view: HistoryView) = view.title.ifBlank { tr(historyKind(view.kind)) }

@Composable fun HistorySummaryCard(view: HistoryView, computer: String, onClick: () -> Unit) {
    HaloCard(Modifier.clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(listOf(view.client, computer).filter { it.isNotBlank() }.joinToString(" · "), Modifier.weight(1f), fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.width(12.dp))
            HistoryStatusMarker(view)
        }
        Text(heading(view), Modifier.padding(vertical = 8.dp), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        val context = listOf(view.project, view.session).filter { it.isNotBlank() }.joinToString(" · ")
        if (context.isNotBlank()) Text(context, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val content = view.questions.firstOrNull()?.question ?: view.fields.firstOrNull()?.second ?: view.excerpt
        val preview = remember(content, view.client) { RichContent.plain(RichContent.parse(content, view.client.equals("codex", true))).take(600) }
        if (preview.isNotBlank() && preview != view.title) Text(preview, Modifier.padding(bottom = 8.dp), fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        Text(listOf(tr(historyKind(view.kind)), displayTime(view.time)).filter { it.isNotBlank() }.joinToString(" · "), fontSize = 12.sp)
    }
}

@Composable fun HistoryList(state: CompanionState, onRefresh: () -> Unit, onEvent: (String) -> Unit, onHistory: (HistoryItem) -> Unit) {
    TextButton(enabled = !state.busy, onClick = onRefresh) { Text(tr("刷新")) }
    Text(tr("最近同步事件"), fontSize = 20.sp); Text(tr("最近 24 小时 · 已同步到手机"), fontSize = 12.sp, modifier = Modifier.padding(bottom = 16.dp))
    val events = state.events.filter { it.summary.optString("state") != "pending" }.sortedByDescending { HistoryPresentation.time(it.detail) }
    if (events.isEmpty()) Text(tr("暂无历史记录"), Modifier.padding(bottom = 16.dp))
    events.forEach { item -> HistorySummaryCard(HistoryPresentation.model(item.detail), state.computers.find { it.key == item.computerKey }?.name ?: tr("电脑")) { onEvent(item.key) } }
    Text(tr("电脑历史"), fontSize = 20.sp); Text(tr("最多保留 30 天、200 条记录／电脑"), fontSize = 12.sp, modifier = Modifier.padding(bottom = 16.dp))
    state.computers.filter { it.state == "active" && !it.online }.forEach { Text(it.name + " · " + tr("电脑离线，暂时无法读取历史"), fontSize = 12.sp) }
    if (state.history.isEmpty()) Text(tr("暂无历史记录"))
    state.history.sortedByDescending { HistoryPresentation.time(it.record) }.forEach { item ->
        HistorySummaryCard(HistoryPresentation.model(item.record), state.computers.find { it.key == item.computerKey }?.name ?: tr("电脑")) { onHistory(item) }
    }
}

@Composable private fun DetailCard(label: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(bottom = 10.dp), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(14.dp)) { Text(tr(label), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.height(6.dp)); content() }
    }
}

@Composable private fun historyStatusColors(tone: HistoryStatusTone): Pair<Color, Color> {
    val dark = isSystemInDarkTheme()
    return when (tone) {
        HistoryStatusTone.Success -> if (dark) Color(0xff163b2a) to Color(0xff9edbb3) else Color(0xffe3f3e8) to Color(0xff21603d)
        HistoryStatusTone.Warning -> if (dark) Color(0xff493617) to Color(0xffffd48a) else Color(0xfffff0d5) to Color(0xff805000)
        HistoryStatusTone.Error -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        HistoryStatusTone.Neutral -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }
}

@Composable private fun HistoryStatusMarker(view: HistoryView) {
    val status = HistoryPresentation.status(view)
    val foreground = if (status.tone == HistoryStatusTone.Error) MaterialTheme.colorScheme.error else historyStatusColors(status.tone).second
    Row(Modifier.widthIn(max = 160.dp).testTag("history-card-status"), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(6.dp).background(foreground, CircleShape))
        Spacer(Modifier.width(5.dp))
        Text(tr(status.label), color = foreground, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable private fun HistoryStatusBadge(view: HistoryView) {
    val status = HistoryPresentation.status(view)
    val (background, foreground) = historyStatusColors(status.tone)
    Surface(modifier = Modifier.widthIn(max = 160.dp).testTag("history-status"), shape = RoundedCornerShape(50), color = background,
        contentColor = foreground, border = BorderStroke(1.dp, foreground.copy(alpha = 0.18f))) {
        Text(tr(status.label), Modifier.padding(horizontal = 12.dp, vertical = 6.dp), fontSize = 12.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable fun HistoryDetailScreen(state: CompanionState, key: String, repo: CompanionRepository? = null, onBack: () -> Unit) {
    val event = if (key.startsWith("event:")) state.events.find { it.key == key.removePrefix("event:") } else null
    val item = state.history.find { "${it.computerKey}/${it.record.optString("id")}" == key }
    val loaded = state.historyDetails[key]
    val view = HistoryPresentation.model(loaded ?: item?.record ?: event?.detail ?: org.json.JSONObject())
    val pc = state.computers.find { it.key == (item?.computerKey ?: event?.computerKey) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        TextButton(onClick = onBack) { Text(tr("← 返回")) }
        Text(heading(view), Modifier.fillMaxWidth().testTag("history-title").padding(top = 12.dp), fontSize = 25.sp, lineHeight = 33.sp, fontWeight = FontWeight.SemiBold)
        Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 22.dp), verticalAlignment = Alignment.CenterVertically) {
            if (view.kind != "completion") {
                Text(tr(historyKind(view.kind)), Modifier.weight(1f, fill = false).padding(end = 10.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
            }
            HistoryStatusBadge(view)
        }
        DetailCard("来源") {
            Text(listOf(pc?.name ?: tr("电脑"), view.client).filter { it.isNotBlank() }.joinToString(" · "))
            if (view.project.isNotBlank()) Text(tr("项目") + ": " + view.project, fontSize = 13.sp)
            if (view.session.isNotBlank()) Text(tr("会话") + ": " + view.session, fontSize = 13.sp)
        }
        DetailCard("内容摘要") {
            if (view.questions.isNotEmpty()) view.questions.forEach { q ->
                Text(q.question, fontSize = 16.sp)
                q.options.forEach { Text("• $it", fontSize = 14.sp) }
                Spacer(Modifier.height(12.dp))
            } else if (view.fields.isNotEmpty()) view.fields.forEach { (label, value) ->
                Text(tr(label), fontSize = 12.sp); Text(value, fontSize = 15.sp); Spacer(Modifier.height(8.dp))
            } else {
                val body = view.excerpt.ifBlank { tr(if (view.unavailable) "内容暂无法解析" else "未提供内容摘要") }
                val isCodex = view.client.equals("codex", true)
                MarkdownContent(body, isCodex)
                val references = remember(body, isCodex) { RichContent.imageReferences(RichContent.parse(body, isCodex)) }
                if (repo != null && pc != null && pc.state == "active" && references.isNotEmpty() && view.kind in listOf("completion", "plan")) {
                    val source = if (event != null) MediaSource(pc.key, "event", event.summary.getString("eventId"), event.summary.getString("pcSessionEpoch"))
                        else MediaSource(pc.key, "history", item!!.record.getString("id"))
                    RecordImages(repo, source, references)
                }
            }
            if (view.shortened) Text(tr("内容已截取。"), fontSize = 12.sp)
            if (view.unavailable && (view.questions.isNotEmpty() || view.fields.isNotEmpty() || view.excerpt.isNotBlank())) Text(tr("记录不完整，当前仅显示可读部分。"), fontSize = 12.sp)
        }
        DetailCard("处理结果") {
            Text(tr(view.result), fontSize = 16.sp)
            view.questions.forEach { q -> Text(tr("回答") + ": " + q.answer.ifBlank { tr("未记录回答") }, fontSize = 14.sp) }
            if (view.result == "已结束" && view.kind in listOf("approval", "question", "input")) Text(tr("未记录具体处理结果"), fontSize = 12.sp)
            Text(displayTime(view.time), fontSize = 13.sp)
        }
        if (loaded == null && item != null) Text(tr(if (state.busy) "正在读取。电脑需要在线。" else "当前显示摘要，完整记录暂不可用。"), fontSize = 12.sp)
    }
}
