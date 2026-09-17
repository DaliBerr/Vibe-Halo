package com.vibe.halo.mobile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibe.halo.mobile.data.*
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun eventTime(value: String): String = runCatching { displayTime(Instant.parse(value).toEpochMilli()) }.getOrDefault("")
private fun displayTime(value: Long): String = if (value <= 0) "" else DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(value))
private fun outcome(value: JSONObject): String = tr(when (value.optString("outcome")) {
    "allow", "once", "always" -> "已允许"; "deny", "reject" -> "已拒绝"; "submit", "answered" -> "已回答"
    "ready" -> "计划已准备好"; "timeout", "expired" -> "已超时"; "disconnected" -> "连接已断开"
    "dismissed", "closed" -> "已关闭"; "native", "fallback" -> "已交回客户端"; else -> "已结束"
})

@Composable fun HistoryList(state: CompanionState, onRefresh: () -> Unit, onEvent: (String) -> Unit, onHistory: (HistoryItem) -> Unit) {
    TextButton(enabled = !state.busy, onClick = onRefresh) { Text(tr("刷新")) }
    Text(tr("最近同步事件"), fontSize = 20.sp); Text(tr("最近 24 小时 · 已同步到手机"), fontSize = 12.sp, modifier = Modifier.padding(bottom = 16.dp))
    val events = state.events.filter { it.summary.optString("state") != "pending" }.sortedByDescending { it.summary.optString("createdAt") }
    if (events.isEmpty()) Text(tr("暂无历史记录"), Modifier.padding(bottom = 16.dp))
    events.forEach { EventCard(it, state) { onEvent(it.key) } }
    Text(tr("电脑历史"), fontSize = 20.sp); Text(tr("最多保留 30 天、200 条记录／电脑"), fontSize = 12.sp, modifier = Modifier.padding(bottom = 16.dp))
    state.computers.filter { it.state == "active" && !it.online }.forEach { Text(it.name + " · " + tr("电脑离线，暂时无法读取历史"), fontSize = 12.sp) }
    if (state.history.isEmpty()) Text(tr("暂无历史记录"))
    state.history.sortedByDescending { HistoryPresentation.time(it.record) }.forEach { item ->
        val pc = state.computers.find { it.key == item.computerKey }; val row = item.record
        HaloCard(Modifier.clickable { onHistory(item) }) {
            Text(row.optString("agentName").ifBlank { row.optString("agentId") } + " · " + (pc?.name ?: tr("电脑")), fontSize = 12.sp)
            val context = listOf(HistoryPresentation.project(row), HistoryPresentation.session(row)).filter { it.isNotBlank() }.joinToString(" · ")
            if (context.isNotBlank()) Text(context, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(HistoryPresentation.preview(row).ifBlank { tr("内容摘要不可用") }, Modifier.padding(vertical = 10.dp), fontSize = 17.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Text(outcome(row) + " · " + displayTime(HistoryPresentation.time(row)), fontSize = 12.sp)
        }
    }
}

@Composable fun HistoryDetailScreen(state: CompanionState, key: String, onBack: () -> Unit) {
    val event = if (key.startsWith("event:")) state.events.find { it.key == key.removePrefix("event:") } else null
    val item = state.history.find { "${it.computerKey}/${it.record.optString("id")}" == key }
    val loaded = state.historyDetails[key]
    val row = loaded ?: item?.record ?: event?.let {
        JSONObject(it.detail.toString()).put("kind", it.summary.optString("kind")).put("agentId", it.summary.optString("agentId"))
            .put("outcome", if (it.summary.optString("kind") == "plan") "ready" else it.summary.optString("state"))
            .put("finalizedAt", runCatching { Instant.parse(it.summary.getString("createdAt")).toEpochMilli() }.getOrDefault(0))
    } ?: JSONObject()
    val pc = state.computers.find { it.key == (item?.computerKey ?: event?.computerKey) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        TextButton(onClick = onBack) { Text(tr("← 返回")) }
        Text(tr("记录详情"), fontSize = 26.sp)
        Text(listOf(pc?.name, row.optString("agentName").ifBlank { row.optString("agentId") }, HistoryPresentation.project(row), HistoryPresentation.session(row)).filterNot { it.isNullOrBlank() }.joinToString(" · "), Modifier.padding(vertical = 12.dp), fontSize = 13.sp)
        Text(outcome(row) + " · " + displayTime(HistoryPresentation.time(row)), fontSize = 13.sp)
        Spacer(Modifier.height(20.dp))
        val questions = row.optJSONArray("questions")
        if (questions != null && questions.length() > 0) {
            for (i in 0 until minOf(questions.length(), 10)) questions.optJSONObject(i)?.let { question -> HaloCard {
                Text(question.optString("question").ifBlank { question.optString("header") }.take(800), fontSize = 17.sp)
                Text(tr("回答") + ": " + question.optString("answer").take(800).ifBlank { tr("未记录回答") }, Modifier.padding(top = 12.dp), fontSize = 14.sp)
            } }
        } else HaloCard { Text(row.optString("excerpt").ifBlank { HistoryPresentation.preview(row) }.take(2400).ifBlank { tr("内容摘要不可用") }, fontSize = 15.sp) }
        if (row.optBoolean("truncated") || row.optBoolean("incomplete")) Text(tr("内容已截取或记录不完整。"), fontSize = 12.sp)
        if (loaded == null && item != null) Text(tr(if (state.busy) "正在读取。电脑需要在线。" else "当前显示摘要，完整记录暂不可用。"), fontSize = 12.sp)
    }
}
