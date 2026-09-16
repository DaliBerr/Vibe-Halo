package com.vibe.halo.mobile

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.vibe.halo.mobile.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val repository get() = (application as VibeHaloApplication).repository
    private val target = mutableStateOf<Triple<String, String, String>?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge(); route(intent)
        lifecycleScope.launch {
            repository.load()
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                repository.resume()
                launch { repository.updates.collect { repository.refresh(); repository.checkReceipts() } }
                while (true) { repository.refresh(); repository.checkReceipts(); delay(30000) }
            }
        }
        if (FirebaseApp.getApps(this).isNotEmpty()) FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> lifecycleScope.launch { repository.registerPushToken(token) } }
        setContent { HaloTheme { CompanionApp(repository, target.value) { target.value = null } } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); route(intent); lifecycleScope.launch { repository.refresh() } }
    private fun route(intent: Intent?) {
        val pcId = intent?.getStringExtra("pcId"); val eventId = intent?.getStringExtra("eventId")
        val epoch = intent?.getStringExtra("pcSessionEpoch")
        if (pcId != null && eventId != null && epoch != null && pcId.length <= 100 && eventId.length <= 240 && epoch.length <= 100) target.value = Triple(pcId, eventId, epoch)
    }
    override fun onStop() { super.onStop(); repository.close() }
}

@Composable fun HaloTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xffa6d8c3), background = Color(0xff121917), surface = Color(0xff19231f), surfaceVariant = Color(0xff25352d))
    else lightColorScheme(primary = Color(0xff245d48), background = Color(0xfff5f7f2), surface = Color.White, surfaceVariant = Color(0xffe7eee4))
    MaterialTheme(colorScheme = colors, content = content)
}
@Composable fun CompanionApp(repo: CompanionRepository, target: Triple<String, String, String>?, consumed: () -> Unit) {
    val state by repo.state.collectAsState(); val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableIntStateOf(0) }; var selected by rememberSaveable { mutableStateOf<String?>(null) }; var pairing by rememberSaveable { mutableStateOf(false) }
    var historySelection by remember { mutableStateOf<String?>(null) }
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(state.message) { if (state.message.isNotEmpty()) snack.showSnackbar(tr(state.message), duration = SnackbarDuration.Long) }
    LaunchedEffect(target, state.events.size) { target?.let { t -> state.events.find { it.summary.optString("pcId") == t.first && it.summary.optString("eventId") == t.second && it.summary.optString("pcSessionEpoch") == t.third }?.let { selected = it.key; consumed() } } }
    BackHandler(selected != null || pairing) { selected = null; pairing = false }
    Scaffold(containerColor = MaterialTheme.colorScheme.background, snackbarHost = { SnackbarHost(snack) }, bottomBar = {
        if (selected == null && !pairing) NavigationBar(containerColor = MaterialTheme.colorScheme.background) {
            listOf("此刻" to "◉", "历史" to "◷", "设备" to "▣").forEachIndexed { i, item -> NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = { Text(item.second, fontSize = 23.sp) }, label = { Text(tr(item.first)) }) }
        }
    }) { padding ->
        val event = state.events.find { it.key == selected }
        when {
            pairing -> PairingScreen(state, repo, Modifier.padding(padding)) { pairing = false }
            event != null -> EventScreen(event, state, repo, Modifier.padding(padding)) { selected = null }
            else -> Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
                Spacer(Modifier.height(28.dp)); Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(28.dp, 12.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(12.dp)))
                    Spacer(Modifier.width(9.dp)); Text("VIBE HALO", fontSize = 12.sp, letterSpacing = 2.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f)); if (state.busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                }
                Spacer(Modifier.height(28.dp)); Text(tr(listOf("掌握此刻。", "每一步，都有记录。", "你的工作，随身连接。")[tab]), fontSize = 30.sp, fontWeight = FontWeight.SemiBold, lineHeight = 39.sp)
                Spacer(Modifier.height(10.dp)); Text(tr(listOf("重要的请求，在这里等你。", "最近 24 小时的状态，清楚可查。", "免账号配对，电脑掌握最终权限。")[tab]), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                Spacer(Modifier.height(24.dp))
                if (tab < 2) {
                    if (tab == 1) {
                        state.computers.filter { it.state == "active" && it.permits("history.read") }.forEach { pc ->
                            OutlinedButton(enabled = !state.busy, onClick = { scope.launch { repo.loadHistory(pc.key) } }, modifier = Modifier.fillMaxWidth()) { Text(tr("读取电脑历史") + " · " + pc.name) }
                        }
                        state.history.forEach { item -> HaloCard(Modifier.clickable { val id = item.record.getString("id"); historySelection = "${item.computerKey}/$id"; scope.launch { repo.loadHistoryDetail(item.computerKey, id) } }) {
                            Text(item.record.optString("agentId"), fontSize = 11.sp); Text(item.record.optString("title").ifBlank { item.record.optString("toolName") }, Modifier.padding(top = 10.dp), fontSize = 17.sp)
                            Text(item.record.optString("outcome") + " · " + tr("只读记录"), Modifier.padding(top = 8.dp), fontSize = 12.sp)
                        } }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(20.dp)) { Text("●  ${state.computers.count { it.online && it.state == "active" }} " + tr("台电脑在线"), Modifier.padding(horizontal = 12.dp, vertical = 7.dp), fontSize = 11.sp) }
                        Spacer(Modifier.weight(1f)); TextButton(enabled = !state.busy, onClick = { scope.launch { repo.refresh(); repo.checkReceipts() } }) { Text(tr("刷新")) }
                    }
                    Spacer(Modifier.height(16.dp)); val events = state.events.filter { (it.summary.optString("state") == "pending") == (tab == 0) }
                    if (events.isEmpty()) HaloCard {
                        Text("○", fontSize = 36.sp, color = MaterialTheme.colorScheme.primary); Spacer(Modifier.height(24.dp))
                        Text(tr(if (state.computers.none { it.state == "active" }) "先连接你的电脑" else "此刻，没有待处理的请求"), fontSize = 18.sp)
                        Text(tr("保持专注，新的进展会出现在这里。"), Modifier.padding(top = 9.dp), fontSize = 13.sp)
                    }
                    for (item in events) HaloCard(Modifier.clickable { selected = item.key }) {
                        Row { Text(item.summary.optString("agentId"), fontSize = 11.sp, color = MaterialTheme.colorScheme.primary); Spacer(Modifier.weight(1f)); Text(state.computers.find { it.key == item.computerKey }?.name ?: "电脑", fontSize = 11.sp) }
                        Text(tr(kindName(item.summary.optString("kind"))), Modifier.padding(top = 16.dp), fontSize = 21.sp, fontWeight = FontWeight.SemiBold)
                        Text(item.detail.optString("toolName"), Modifier.padding(top = 8.dp), fontSize = 13.sp)
                        Text(tr("查看详情  →"), Modifier.padding(top = 18.dp), fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                    }
                    if (state.computers.none { it.state == "active" }) Button(onClick = { pairing = true }, Modifier.fillMaxWidth().height(52.dp)) { Text(tr("连接电脑")) }
                } else {
                    val context = androidx.compose.ui.platform.LocalContext.current
                    Row {
                        for ((label, mode) in listOf("跟随系统" to "system", "中文" to "zh-CN", "English" to "en-US")) TextButton(onClick = {
                            UiLanguage.mode = mode
                            context.getSharedPreferences("ui-preferences", android.content.Context.MODE_PRIVATE).edit().putString("language", mode).apply()
                        }) { Text(tr(label)) }
                    }
                    state.computers.forEach { pc -> ComputerCard(pc, state.busy, repo) }
                    Button(onClick = { pairing = true }, Modifier.fillMaxWidth().height(52.dp)) { Text(tr("＋ 连接另一台电脑")) }
                    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> scope.launch { snack.showSnackbar(tr(if (granted) "通知已允许" else "仍可在应用内查看请求")) } }
                    OutlinedButton(onClick = { if (Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS) }, Modifier.fillMaxWidth().padding(top = 18.dp)) { Text(tr("允许系统通知")) }
                    Text(tr("通知只提示查看；批准和回答只在详情页提交。手表使用系统通知镜像。"), Modifier.padding(top = 12.dp), fontSize = 12.sp, lineHeight = 20.sp)
                    if (BuildConfig.FIREBASE_APP_ID.isEmpty()) Text(tr("此构建尚未配置推送服务，当前可在前台同步。"), Modifier.padding(top = 12.dp), fontSize = 12.sp)
                }
                Spacer(Modifier.height(32.dp))
            }
        }
    }
    historySelection?.let { key -> AlertDialog(onDismissRequest = { historySelection = null }, title = { Text(tr("电脑历史 · 只读")) }, text = {
        androidx.compose.foundation.text.selection.SelectionContainer { Text(state.historyDetails[key] ?: tr("正在读取。电脑需要在线。"), Modifier.heightIn(max = 450.dp).verticalScroll(rememberScrollState()), fontSize = 12.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace) }
    }, confirmButton = { TextButton(onClick = { historySelection = null }) { Text(tr("关闭")) } }) }
}
@Composable fun HaloCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth().padding(bottom = 16.dp), shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surface) { Column(Modifier.padding(22.dp), content = content) }
}
fun kindName(kind: String) = when (kind) { "approval" -> "等待审批"; "question" -> "等待回答"; "input" -> "等待原生输入"; "plan" -> "计划已就绪"; else -> "任务已完成" }
@Composable private fun ComputerCard(pc: Computer, busy: Boolean, repo: CompanionRepository) {
    val scope = rememberCoroutineScope(); var confirm by remember { mutableStateOf(false) }
    HaloCard {
        Text(pc.name, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Text(tr(if (pc.state != "active") "已撤销" else if (pc.online) "已连接 · ${if (pc.transport == "lan") "局域网" else "云端"}" else "离线 · 仅供查看"), Modifier.padding(top = 6.dp), fontSize = 12.sp)
        Text(pc.origin, Modifier.padding(top = 12.dp), fontSize = 11.sp)
        Text(pc.grant.getJSONArray("scopes").let { scopes -> (0 until scopes.length()).map { tr(when (scopes.getString(it)) { "events.read" -> "查看事件"; "history.read" -> "读取历史"; "approvals.decide" -> "提交审批"; "questions.answer" -> "精确回答"; "reminders.dismiss" -> "关闭提醒"; else -> "长期授权" }) }.joinToString(" · ") }, Modifier.padding(top = 6.dp), fontSize = 12.sp)
        if (pc.state == "active") Row {
            TextButton(enabled = !busy, onClick = { scope.launch { repo.notificationPreferences(pc.key, false) } }) { Text(tr("静音")) }
            TextButton(enabled = !busy, onClick = { scope.launch { repo.notificationPreferences(pc.key, true) } }) { Text(tr("恢复提醒")) }
            TextButton(enabled = !busy, onClick = { confirm = true }) { Text(tr("撤销")) }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text(tr("撤销连接？")) }, text = { Text(tr("清除手机上的相关缓存。离线电脑收到撤销后，局域网权限才会关闭。")) }, confirmButton = { TextButton(onClick = { confirm = false; scope.launch { repo.revoke(pc.key) } }) { Text(tr("撤销")) } }, dismissButton = { TextButton(onClick = { confirm = false }) { Text(tr("取消")) } })
}
