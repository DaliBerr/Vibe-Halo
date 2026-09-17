package com.vibe.halo.mobile

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibe.halo.mobile.data.*
import kotlinx.coroutines.launch

@Composable fun CompanionApp(repo: CompanionRepository, target: Triple<String, String, String>?, consumed: () -> Unit) {
    val state by repo.state.collectAsState(); val scope = rememberCoroutineScope(); val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("onboarding", Context.MODE_PRIVATE) }
    var introComplete by remember { mutableStateOf(prefs.getBoolean("complete", false)) }
    var setup by rememberSaveable { mutableStateOf(false) }; var pairing by rememberSaveable { mutableStateOf(false) }
    var tab by rememberSaveable { mutableIntStateOf(0) }; var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var historySelection by rememberSaveable { mutableStateOf<String?>(null) }
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(state.loaded) {
        if (state.loaded && !prefs.getBoolean("initialized", false)) {
            introComplete = state.computers.any { it.state == "active" }
            prefs.edit().putBoolean("initialized", true).putBoolean("complete", introComplete).apply()
        }
    }
    LaunchedEffect(state.message) { if (state.message.isNotEmpty()) snack.showSnackbar(tr(state.message)) }
    LaunchedEffect(target, state.events, introComplete) {
        if (introComplete) target?.let { t -> state.events.find { it.summary.optString("pcId") == t.first && it.summary.optString("eventId") == t.second && it.summary.optString("pcSessionEpoch") == t.third }?.let { selected = it.key; consumed() } }
    }
    val onlineHistory = state.computers.filter { it.online && it.state == "active" && it.permits("history.read") }.map { it.key }
    LaunchedEffect(tab, onlineHistory, introComplete) {
        if (introComplete && tab == 1) onlineHistory.forEach { repo.loadHistory(it) }
    }
    BackHandler(pairing || setup || selected != null || historySelection != null) { pairing = false; setup = false; selected = null; historySelection = null }
    Scaffold(snackbarHost = { SnackbarHost(snack) }, bottomBar = {
        if (state.loaded && introComplete && !pairing && !setup && selected == null && historySelection == null) NavigationBar {
            listOf("待处理" to "◉", "历史记录" to "◷", "设备" to "▣").forEachIndexed { i, item -> NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = { Text(item.second) }, label = { Text(tr(item.first)) }) }
        }
    }) { padding -> Box(Modifier.padding(padding).fillMaxSize()) {
        val event = state.events.find { it.key == selected }
        when {
            !state.loaded && state.loadError -> Column(Modifier.align(Alignment.Center).padding(24.dp)) {
                Text(tr("无法读取已保存的设备。数据已保留，请重试。"))
                Button(enabled = !state.busy, onClick = { scope.launch { repo.load() } }) { Text(tr("重试")) }
            }
            !state.loaded -> CircularProgressIndicator(Modifier.align(Alignment.Center))
            pairing -> PairingScreen(state, repo, Modifier) { pairing = false }
            !introComplete || setup -> SetupScreen(!introComplete, state.computers.any { it.state == "active" }, { pairing = true }) {
                introComplete = true; setup = false; prefs.edit().putBoolean("complete", true).apply()
            }
            historySelection != null -> HistoryDetailScreen(state, historySelection!!) { historySelection = null }
            event != null -> EventScreen(event, state, repo, Modifier) { selected = null }
            else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Image(painterResource(R.drawable.halo_brand), null, Modifier.size(36.dp)); Spacer(Modifier.width(10.dp))
                    Text("Vibe Halo", fontWeight = FontWeight.SemiBold); Spacer(Modifier.weight(1f))
                    if (state.busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
                Text(tr(listOf("待处理", "历史记录", "设备")[tab]), Modifier.padding(vertical = 24.dp), fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
                when (tab) {
                    0 -> {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${state.computers.count { it.online && it.state == "active" }} " + tr("台电脑在线"), fontSize = 13.sp)
                            Spacer(Modifier.weight(1f)); TextButton(onClick = { scope.launch { repo.refresh() } }, enabled = !state.busy) { Text(tr("刷新")) }
                        }
                        val pending = state.events.filter { it.summary.optString("state") == "pending" }.sortedByDescending { it.summary.optString("createdAt") }
                        if (pending.isEmpty()) HaloCard { Text(tr("暂无待处理请求")) }
                        pending.forEach { item -> EventCard(item, state) { selected = item.key } }
                        if (state.computers.none { it.state == "active" }) Button(onClick = { pairing = true }) { Text(tr("连接电脑")) }
                    }
                    1 -> HistoryList(state, onRefresh = { scope.launch { repo.refresh(); state.computers.filter { it.state == "active" && it.permits("history.read") }.forEach { repo.loadHistory(it.key) } } }, onEvent = { historySelection = "event:$it" }, onHistory = { item ->
                        val id = item.record.getString("id"); historySelection = "${item.computerKey}/$id"
                        scope.launch { repo.loadHistoryDetail(item.computerKey, id) }
                    })
                    else -> {
                        DeviceNameCard(state, repo)
                        Row { for ((label, mode) in listOf("跟随系统" to "system", "中文" to "zh-CN", "English" to "en-US")) TextButton(onClick = {
                            UiLanguage.mode = mode; context.getSharedPreferences("ui-preferences", Context.MODE_PRIVATE).edit().putString("language", mode).apply()
                            com.vibe.halo.mobile.notifications.CompanionNotifications.channels(context); scope.launch { repo.refresh() }
                        }) { Text(tr(label)) } }
                        state.computers.forEach { ComputerCard(it, state.busy, repo) }
                        Button(onClick = { pairing = true }, Modifier.fillMaxWidth()) { Text(tr("连接另一台电脑")) }
                        OutlinedButton(onClick = { setup = true }, Modifier.fillMaxWidth()) { Text(tr("通知与后台设置")) }
                        if (BuildConfig.FIREBASE_APP_ID.isEmpty()) Text(tr("此构建尚未配置推送服务，当前可在前台同步。"), fontSize = 12.sp)
                    }
                }
            }
        }
    } }
}

@Composable fun HaloCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth().padding(bottom = 16.dp), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) { Column(Modifier.padding(20.dp), content = content) }
}
fun kindName(kind: String) = when (kind) { "approval" -> "等待审批"; "question" -> "等待回答"; "input" -> "需要回到电脑处理"; "plan" -> "计划已准备好"; else -> "任务已完成" }

@Composable fun EventCard(item: RemoteEvent, state: CompanionState, onClick: () -> Unit) {
    HaloCard(Modifier.clickable(onClick = onClick)) {
        Text(item.summary.optString("agentId") + " · " + (state.computers.find { it.key == item.computerKey }?.name ?: tr("电脑")), fontSize = 12.sp)
        Text(HistoryPresentation.preview(item.detail).ifBlank { tr(kindName(item.summary.optString("kind"))) }, Modifier.padding(vertical = 10.dp), fontSize = 17.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        Text(tr(if (item.summary.optString("state") != "pending" && item.summary.optString("kind") in listOf("input", "approval", "question")) "已结束" else kindName(item.summary.optString("kind"))) + " · " + eventTime(item.summary.optString("createdAt")), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun DeviceNameCard(state: CompanionState, repo: CompanionRepository) {
    val scope = rememberCoroutineScope(); var edit by remember { mutableStateOf(false) }; var name by remember { mutableStateOf("") }; var error by remember { mutableStateOf(false) }
    HaloCard {
        Text(tr("这台手机"), fontSize = 12.sp); Text(state.deviceName, fontSize = 22.sp)
        if (state.namePending) Text(tr("名称待同步"), fontSize = 12.sp)
        Row { TextButton(onClick = { name = state.deviceName; error = false; edit = true }) { Text(tr("修改名称")) }; TextButton(onClick = { scope.launch { repo.renameDevice(null) } }) { Text(tr("恢复系统名称")) } }
    }
    if (edit) AlertDialog(onDismissRequest = { edit = false }, title = { Text(tr("修改名称")) }, text = {
        Column { OutlinedTextField(name, { name = it; error = false }, singleLine = true, isError = error); if (error) Text(tr("名称须为 1–48 个字符，不能包含控制字符。")) }
    }, confirmButton = { TextButton(onClick = { if (runCatching { DeviceNames.checked(name) }.isSuccess) { edit = false; scope.launch { repo.renameDevice(name) } } else error = true }) { Text(tr("保存")) } }, dismissButton = { TextButton(onClick = { edit = false }) { Text(tr("取消")) } })
}

@Composable private fun ComputerCard(pc: Computer, busy: Boolean, repo: CompanionRepository) {
    val scope = rememberCoroutineScope(); var details by remember { mutableStateOf(false) }; var revoke by remember { mutableStateOf(false) }
    HaloCard {
        Text(pc.name, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Text(tr(if (pc.state != "active") "已撤销" else if (pc.online) if (pc.transport == "lan") "已连接 · 局域网" else "已连接 · 云端" else "离线 · 仅供查看"), fontSize = 13.sp)
        TextButton(onClick = { details = !details }) { Text(tr("连接详情")) }
        if (details) {
            Text(pc.origin, fontSize = 12.sp)
            val scopes = pc.grant.getJSONArray("scopes")
            Text((0 until scopes.length()).joinToString(" · ") { tr(when (scopes.getString(it)) { "events.read" -> "查看事件"; "history.read" -> "读取历史"; "approvals.decide" -> "提交审批"; "questions.answer" -> "精确回答"; "reminders.dismiss" -> "关闭提醒"; else -> "长期授权" }) }, fontSize = 12.sp)
        }
        if (pc.state == "active") Row {
            TextButton(enabled = !busy, onClick = { scope.launch { repo.notificationPreferences(pc.key, false) } }) { Text(tr("静音")) }
            TextButton(enabled = !busy, onClick = { scope.launch { repo.notificationPreferences(pc.key, true) } }) { Text(tr("恢复提醒")) }
            TextButton(enabled = !busy, onClick = { revoke = true }) { Text(tr("撤销")) }
        }
    }
    if (revoke) AlertDialog(onDismissRequest = { revoke = false }, title = { Text(tr("撤销连接？")) }, text = { Text(tr("清除手机上的相关缓存。离线电脑收到撤销后，局域网权限才会关闭。")) }, confirmButton = { TextButton(onClick = { revoke = false; scope.launch { repo.revoke(pc.key) } }) { Text(tr("撤销")) } }, dismissButton = { TextButton(onClick = { revoke = false }) { Text(tr("取消")) } })
}
