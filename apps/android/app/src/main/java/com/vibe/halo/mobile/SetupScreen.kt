package com.vibe.halo.mobile

import android.Manifest
import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.delay

data class SetupChecks(val notifications: Boolean, val blockedChannels: List<String>, val batteryExempt: Boolean, val backgroundRestricted: Boolean?)
internal fun setupChecks(context: Context): SetupChecks {
    val manager = context.getSystemService(NotificationManager::class.java)
    val channels = listOf("approvals", "questions", "completions")
    val blocked = channels.filter { manager.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE }
    val permission = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED
    return SetupChecks(permission && NotificationManagerCompat.from(context).areNotificationsEnabled() && blocked.isEmpty(), blocked,
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName),
        if (Build.VERSION.SDK_INT >= 28) (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isBackgroundRestricted else null)
}
internal class SetupProgress(context: Context, preferenceName: String = "onboarding") {
    private val prefs = context.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
    fun initialize(paired: Boolean): Boolean {
        if (!prefs.getBoolean("initialized", false)) prefs.edit().putBoolean("initialized", true).putBoolean("complete", paired).apply()
        return prefs.getBoolean("complete", false)
    }
    var step: Int
        get() = prefs.getInt("wizard-step", 0).coerceIn(0, 3)
        set(value) { prefs.edit().putInt("wizard-step", value.coerceIn(0, 3)).apply() }
    fun skip(step: Int) { prefs.edit().putBoolean("wizard-skipped-$step", true).apply() }
    fun visited(step: Int) { prefs.edit().putBoolean("wizard-visited-$step", true).apply() }
    fun saveChecks(checks: SetupChecks) { prefs.edit().putBoolean("notification-verified", checks.notifications).putBoolean("battery-exempt", checks.batteryExempt).apply() }
}
private fun appSettings(context: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
private fun openSettings(context: Context, intent: Intent): Boolean = runCatching { context.startActivity(intent) }.isSuccess

@Composable fun SetupScreen(required: Boolean, connected: Boolean, onConnect: () -> Unit, onDone: () -> Unit, pairingContent: (@Composable () -> Unit)? = null, checksProvider: (Context) -> SetupChecks = ::setupChecks) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("onboarding", Context.MODE_PRIVATE) }
    val progress = remember { SetupProgress(context) }
    var step by remember { mutableIntStateOf(if (required && !connected) 0 else progress.step) }
    var revision by remember { mutableIntStateOf(0) }
    var openedSettings by remember { mutableStateOf(false) }
    var lockTip by remember { mutableStateOf(false) }
    var jumpError by remember { mutableStateOf(false) }
    // Back navigation must not immediately auto-forward through an already verified step.
    var autoForward by remember { mutableStateOf(true) }
    val owner = context as ComponentActivity
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) { revision++; openedSettings = false } }
        owner.lifecycle.addObserver(observer); onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val checks = remember(revision) { checksProvider(context).also { progress.saveChecks(it) } }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { revision++; autoForward = true }
    val xiaomi = Build.MANUFACTURER.lowercase() in listOf("xiaomi", "redmi", "poco")
    fun go(next: Int, automatic: Boolean = true) { step = next; progress.step = next; autoForward = automatic; lockTip = false; jumpError = false }
    fun next() { if (required && !connected) go(0) else if (step < 3) go(step + 1) else onDone() }
    LaunchedEffect(step, connected, checks.notifications, autoForward) {
        if (autoForward && ((step == 0 && connected) || (step == 1 && checks.notifications))) { delay(650); go(step + 1) }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val compact = maxHeight < 600.dp || LocalDensity.current.fontScale > 1.5f
    @Composable fun Tip() {
        Surface(color = Color.Black, contentColor = Color.White, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            Text(tr(if (step == 2) "上滑并停留，找到 Vibe Halo，长按卡片后点锁形按钮。" else if (xiaomi) "省电策略设为不限制，并允许后台自启动。" else "在应用详情中允许后台运行。"), Modifier.padding(12.dp), fontSize = 13.sp)
        }
    }
    val showTip = (step == 2 && lockTip) || step == 3
    Column(Modifier.fillMaxSize().imePadding().padding(horizontal = 24.dp, vertical = 12.dp)) {
        Row { Image(painterResource(R.drawable.halo_brand), null, Modifier.size(32.dp)); Spacer(Modifier.weight(1f)); Text("${step + 1} / 4", fontSize = 14.sp) }
        Text(tr(listOf("连接电脑", "允许系统通知", "后台锁定", "后台省电设置")[step]), fontSize = if (compact) 20.sp else 26.sp, maxLines = if (compact) 1 else 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(vertical = if (compact) 6.dp else 12.dp))
        LinearProgressIndicator(progress = { (step + 1) / 4f }, modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp))
        if (step == 0 && !connected && pairingContent != null) Box(Modifier.weight(1f)) { pairingContent() }
        else Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
            when(step) {
                0 -> {
                    Text(tr(if (connected) "已配对，即将继续" else "请先完成一台电脑的配对。"))
                    if (!connected) Button(onClick = onConnect) { Text(tr("连接电脑")) }
                }
                1 -> {
                    Text(tr(if (checks.notifications) "通知已开启，即将继续" else "允许通知，及时收到审批、问题和完成提醒。"))
                    if (checks.blockedChannels.isNotEmpty()) Text(tr("部分通知类别已关闭，请在通知设置中开启。"), modifier = Modifier.padding(top = 12.dp))
                }
                2 -> {
                    Text(tr("上滑并停留，打开最近任务；三键导航请点击最近任务键。"))
                    HaloCard(Modifier.padding(top = 20.dp)) {
                        Image(painterResource(R.drawable.halo_brand), null, Modifier.size(48.dp))
                        Text("Vibe Halo", fontSize = 20.sp)
                        Text(tr("长按应用卡片 → 点击锁形按钮"), Modifier.padding(top = 16.dp))
                    }
                    Text(tr("返回后可直接下一步。系统未提供后台锁定的检测结果。"), fontSize = 13.sp)
                }
                3 -> {
                    Text(tr(if (xiaomi) "应用详情 → 省电策略 → 不限制；同时允许后台自启动。" else "在应用的电池设置中允许后台运行，或取消电池优化。"))
                    Spacer(Modifier.height(20.dp))
                    Text(tr(if (checks.batteryExempt) "系统电池优化：已豁免" else "系统电池优化：未豁免"), fontSize = 14.sp)
                    Text(tr(when(checks.backgroundRestricted) { true -> "系统后台限制：已开启"; false -> "系统后台限制：未开启"; null -> "系统后台限制：无法检测" }), fontSize = 14.sp)
                    if (xiaomi) Text(tr("小米省电策略与自启动：未验证"), Modifier.padding(top = 12.dp), fontSize = 14.sp)
                    Text(tr("返回后自动刷新可检测的状态，无需手动确认。"), Modifier.padding(top = 12.dp), fontSize = 13.sp)
                }
            }
            if (jumpError) Text(tr("无法打开系统设置，请从系统设置中找到 Vibe Halo。"), Modifier.padding(top = 12.dp))
            if (compact && showTip) Tip()
        }
        if (!compact && showTip) Tip()
        when(step) {
            1 -> Button(onClick = {
                autoForward = true
                if (Build.VERSION.SDK_INT >= 33 && !checks.notifications && (!prefs.getBoolean("notification-requested", false) || owner.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
                    prefs.edit().putBoolean("notification-requested", true).apply(); launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else { openedSettings = true; jumpError = !openSettings(context, Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }
            }, Modifier.fillMaxWidth()) { Text(tr("打开通知设置")) }
            2 -> OutlinedButton(onClick = { lockTip = true; progress.visited(step); Toast.makeText(context, tr("长按 Vibe Halo 卡片，点击锁形按钮。"), Toast.LENGTH_LONG).show() }, Modifier.fillMaxWidth()) { Text(tr("显示锁定提示")) }
            3 -> Button(enabled = !openedSettings, onClick = {
                progress.visited(step); openedSettings = true
                Toast.makeText(context, tr(if (xiaomi) "省电策略设为不限制，并允许后台自启动。" else "在应用详情中允许后台运行。"), Toast.LENGTH_LONG).show()
                jumpError = !openSettings(context, appSettings(context)); if (jumpError) openedSettings = false
            }, modifier = Modifier.fillMaxWidth()) { Text(tr("打开应用详情")) }
        }
        if (step >= 2 || (step == 0 && connected)) Button(onClick = { next() }, Modifier.fillMaxWidth()) { Text(tr(if (step == 3) if (required) "进入应用" else "完成" else "下一步")) }
        if (step == 0 && !connected && pairingContent == null) Button(enabled = false, onClick = {}, modifier = Modifier.fillMaxWidth()) { Text(tr("下一步")) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(enabled = step > 0, onClick = { go(step - 1, false) }) { Text(tr("上一步")) }
            if (step > 0) TextButton(onClick = { progress.skip(step); next() }) { Text(tr("稍后设置")) }
            if (!required && step == 0) TextButton(onClick = onDone) { Text(tr("完成")) }
        }
    }
    }
}
