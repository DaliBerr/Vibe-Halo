package com.vibe.halo.mobile

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibe.halo.mobile.data.*
import com.vibe.halo.mobile.security.Wire.Companion.values
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@Composable fun PairingScreen(state: CompanionState, repo: CompanionRepository, modifier: Modifier, back: () -> Unit) {
    val scope = rememberCoroutineScope(); var origin by rememberSaveable { mutableStateOf("") }; var code by remember { mutableStateOf("") }
    LaunchedEffect(state.pairing?.pairingId) { while (repo.state.value.pairing != null) { delay(3000); repo.pollPairing() } }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        TextButton(onClick = back) { Text(tr("← 返回")) }; Spacer(Modifier.height(20.dp)); Text(tr("连接，从信任开始。"), fontSize = 29.sp, fontWeight = FontWeight.SemiBold)
        Text(tr("在电脑托盘打开「手机伴侣」，将服务地址与配对码填在这里。"), Modifier.padding(vertical = 18.dp), fontSize = 14.sp, lineHeight = 23.sp)
        val pair = state.pairing
        if (pair == null) {
            OutlinedTextField(origin, { origin = it.take(240) }, label = { Text(tr("中继服务地址")) }, placeholder = { Text("https://relay.example.com") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(16.dp)); OutlinedTextField(code, { code = it.take(100) }, label = { Text(tr("一次性配对码")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Button(enabled = !state.busy && origin.isNotBlank() && code.isNotBlank(), onClick = { scope.launch { repo.beginPairing(origin, code); code = "" } }, modifier = Modifier.fillMaxWidth().padding(top = 24.dp).height(52.dp)) { Text(tr("核对设备")) }
        } else {
            HaloCard {
                Text(pair.name, fontSize = 21.sp); Text(tr("两端指纹"), Modifier.padding(top = 22.dp), fontSize = 12.sp)
                SelectionContainer { Text(pair.fingerprint, Modifier.padding(vertical = 15.dp), fontFamily = FontFamily.Monospace, fontSize = 24.sp, color = MaterialTheme.colorScheme.primary) }
                Text(tr(if (pair.confirmedOnPc) "电脑已确认。指纹一致后，完成绑定。" else "请在电脑上核对同样的指纹并确认。"), fontSize = 13.sp)
            }
            Button(enabled = pair.confirmedOnPc && !state.busy, onClick = { scope.launch { repo.finishPairing(); if (repo.state.value.pairing == null) { repo.refresh(); back() } } }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text(tr(if (pair.confirmedOnPc) "指纹一致，完成绑定" else "等待电脑确认…")) }
        }
    }
}
@Composable fun EventScreen(event: RemoteEvent, state: CompanionState, repo: CompanionRepository, modifier: Modifier, back: () -> Unit) {
    val scope = rememberCoroutineScope(); val answers = remember(event.key, event.summary.optLong("eventRevision")) { mutableStateMapOf<String, List<String>>() }
    var tick by remember { mutableLongStateOf(0) }; LaunchedEffect(event.key) { while (true) { delay(1000); tick++ } }
    val active = tick.let { repo.actionable(event) } && !state.busy
    var persistentOption by remember { mutableStateOf<String?>(null) }
    var scopeChecked by remember { mutableStateOf(false) }
    val execute: (String, Boolean) -> Unit = { id, persistent ->
        val payload = if (id == "submit") JSONObject().apply {
            for (question in event.detail.getJSONArray("questions").values().map { it as JSONObject }) {
                val values = answers[question.getString("id")].orEmpty()
                put(question.getString("id"), if (question.getBoolean("multiSelect")) JSONArray(values) else values.firstOrNull().orEmpty())
            }
        } else null
        scope.launch { repo.decide(event.key, id, payload, persistent); repo.checkReceipts(); repo.refresh() }
    }
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) { TextButton(onClick = back) { Text(tr("← 返回")) }; Spacer(Modifier.weight(1f)); TextButton(enabled = !state.busy, onClick = { scope.launch { repo.refresh(); repo.checkReceipts() } }) { Text(tr("刷新状态")) } }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
            Text(event.summary.optString("agentId").uppercase(), fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
            Text(tr(kindName(event.summary.optString("kind"))), Modifier.padding(top = 14.dp, bottom = 20.dp), fontSize = 29.sp, fontWeight = FontWeight.SemiBold)
            state.computers.find { it.key == event.computerKey }?.let { pc ->
                Text(pc.name + " · " + tr(if (pc.online) "已连接" else "离线 · 仅供查看"), fontSize = 12.sp)
            }
            if (event.summary.optString("state") == "pending") {
                val seconds = tick.let { repo.remainingSeconds(event) }
                Text(tr(if (event.summary.optBoolean("actionable")) "当前请求" else "排队或等待原生处理") + " · " + event.summary.optInt("pendingCount") + " " + tr("项待处理") + (seconds?.let { " · ${tr("剩余")} ${it}s" } ?: ""), Modifier.padding(vertical = 10.dp), fontSize = 12.sp)
            }
            HaloCard {
                Text(event.detail.optString("toolName").ifBlank { tr("事件详情") }, fontWeight = FontWeight.Bold)
                SelectionContainer { Column { Text(event.detail.optString("description"), Modifier.padding(top = 12.dp), fontSize = 13.sp); Text(event.detail.optString("toolInputText"), Modifier.padding(top = 12.dp), fontSize = 12.sp, fontFamily = FontFamily.Monospace) } }
            }
            if (event.detail.optBoolean("truncated") || event.detail.optBoolean("redacted")) Text(tr("详情有省略或脱敏，当前不能从这里授权。"), fontSize = 12.sp)
            for (question in event.detail.getJSONArray("questions").values().map { it as JSONObject }) {
                val id = question.getString("id"); val selected = answers[id].orEmpty(); val multi = question.getBoolean("multiSelect")
                Text(question.getString("question"), Modifier.padding(top = 22.dp, bottom = 10.dp), fontSize = 17.sp, fontWeight = FontWeight.Medium)
                for (option in question.getJSONArray("options").values().map { it as JSONObject }) {
                    val value = option.getString("id")
                    Row(Modifier.fillMaxWidth().clickable(enabled = active) { answers[id] = if (!multi) listOf(value) else if (value in selected) selected - value else selected + value }.padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (multi) Checkbox(value in selected, onCheckedChange = null) else RadioButton(value in selected, onClick = null)
                        Column(Modifier.padding(start = 12.dp)) { Text(option.getString("label"), fontSize = 14.sp); if (option.getString("description").isNotBlank()) Text(option.getString("description"), fontSize = 12.sp) }
                    }
                }
                if (question.getBoolean("allowText")) {
                    var text by remember(event.key, id) { mutableStateOf("") }
                    OutlinedTextField(text, { text = it.take(2000); answers[id] = if (text.isBlank()) emptyList() else listOf(text) }, enabled = active, label = { Text(tr("补充回答")) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                }
            }
            if (event.summary.optString("kind") == "input") {
                Text(tr("这类输入需要回到原客户端回答。"), Modifier.padding(vertical = 20.dp))
                if (event.summary.optString("state") == "pending" && state.computers.any { it.key == event.computerKey && it.online && it.permits("reminders.dismiss") }) TextButton(enabled = !state.busy, onClick = { scope.launch { repo.dismissReminder(event.key); repo.refresh() } }) { Text(tr("关闭这条提醒")) }
            }
            if (!active) Text(tr("当前只读：请刷新状态，或回到电脑处理。"), Modifier.padding(vertical = 20.dp), fontSize = 12.sp)
            Spacer(Modifier.height(20.dp))
        }
        Surface(shadowElevation = 8.dp, color = MaterialTheme.colorScheme.background) { Column(Modifier.fillMaxWidth().heightIn(max = 230.dp).verticalScroll(rememberScrollState()).padding(16.dp)) {
            for (option in event.detail.getJSONArray("options").values().map { it as JSONObject }) {
                val id = option.getString("id")
                val ready = id != "submit" || event.detail.getJSONArray("questions").values().all { answers[(it as JSONObject).getString("id")]?.isNotEmpty() == true }
                val label = option.optString("label").ifBlank { when { id in listOf("allow", "once") -> "允许这一次"; id in listOf("deny", "reject") -> "拒绝"; id == "submit" -> "提交回答"; id == "always" || id.startsWith("suggestion:") -> "查看长期授权范围…"; else -> "回到客户端处理" } }
                Button(enabled = active && ready, onClick = {
                    if (id == "always" || id.startsWith("suggestion:")) { scopeChecked = false; persistentOption = id } else execute(id, false)
                }, modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp), colors = if (id in listOf("deny", "reject")) ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer) else ButtonDefaults.buttonColors()) { Text(tr(label)) }
            }
            if (repo.hasPendingDecision(event.key)) TextButton(enabled = !state.busy, onClick = { scope.launch { repo.retryDecision(event.key); repo.checkReceipts() } }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text(tr("查询 / 重试上次提交"), fontSize = 11.sp) }
        } }
    }
    persistentOption?.let { id ->
        AlertDialog(onDismissRequest = { persistentOption = null }, title = { Text(tr("确认长期授权范围")) }, text = {
            Column {
                Text(tr("这项规则可能影响后续请求。请核对完整范围。"), fontSize = 13.sp)
                SelectionContainer { Text(event.detail.optJSONObject("persistentPreviews")?.optString(id).orEmpty(), Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState()).padding(vertical = 16.dp), fontFamily = FontFamily.Monospace, fontSize = 12.sp) }
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(scopeChecked, { scopeChecked = it }); Text(tr("我已核对完整范围"), fontSize = 13.sp) }
            }
        }, confirmButton = { TextButton(enabled = active && scopeChecked, onClick = { persistentOption = null; execute(id, true) }) { Text(tr("确认授权")) } }, dismissButton = { TextButton(onClick = { persistentOption = null }) { Text(tr("取消")) } })
    }
}
