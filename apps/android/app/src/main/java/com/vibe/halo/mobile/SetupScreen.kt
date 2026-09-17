package com.vibe.halo.mobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.activity.ComponentActivity

private fun openSettings(context: Context, intent: Intent) = runCatching { context.startActivity(intent) }.isSuccess
private fun appSettings(context: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))

@Composable fun SetupScreen(required: Boolean, connected: Boolean, onConnect: () -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("onboarding", Context.MODE_PRIVATE) }
    var revision by remember { mutableIntStateOf(0) }
    var showLock by remember { mutableStateOf(false) }
    val owner = context as ComponentActivity
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) revision++ }
        owner.lifecycle.addObserver(observer); onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val notificationEnabled = remember(revision) { NotificationManagerCompat.from(context).areNotificationsEnabled() }
    val batteryExempt = remember(revision) { (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { revision++ }
    val xiaomi = Build.MANUFACTURER.lowercase() in listOf("xiaomi", "redmi", "poco")
    fun mark(key: String, value: String) { prefs.edit().putString(key, value).apply(); revision++ }
    fun status(key: String, detected: Boolean = false): String {
        revision
        return if (detected) "已开启" else when (prefs.getString(key, "")) { "confirmed" -> "已手动确认"; "skipped" -> "稍后设置"; else -> "未设置" }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Image(painterResource(R.drawable.halo_brand), null, Modifier.size(56.dp))
        Text(tr(if (required) "设置手机伴侣" else "通知与后台设置"), fontSize = 26.sp, modifier = Modifier.padding(vertical = 16.dp))
        Text(tr("完成电脑连接后即可使用，其他设置可以稍后完成。"), fontSize = 13.sp)
        Spacer(Modifier.height(20.dp))
        HaloCard {
            Text("1 · " + tr("允许系统通知"), fontSize = 19.sp)
            Text(tr(status("notifications", notificationEnabled)))
            Button(onClick = {
                if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("notification-requested", false)) {
                    prefs.edit().putBoolean("notification-requested", true).apply(); launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else if (!openSettings(context, Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))) openSettings(context, appSettings(context))
            }) { Text(tr(if (notificationEnabled) "通知设置" else "允许系统通知")) }
            if (!notificationEnabled) TextButton(onClick = { mark("notifications", "skipped") }) { Text(tr("稍后设置")) }
        }
        HaloCard {
            Text("2 · " + tr("后台锁定"), fontSize = 19.sp); Text(tr(status("lock")))
            Text(tr(if (xiaomi) "在最近任务中长按 Vibe Halo 卡片，点击锁形按钮。不同系统版本的入口可能不同。" else "如果系统支持，请在最近任务中锁定 Vibe Halo。"), fontSize = 13.sp)
            TextButton(onClick = { showLock = true }) { Text(tr("查看操作步骤")) }
            Row { TextButton(onClick = { mark("lock", "confirmed") }) { Text(tr("我已完成")) }; TextButton(onClick = { mark("lock", "skipped") }) { Text(tr("稍后设置")) } }
        }
        HaloCard {
            Text("3 · " + tr("后台省电策略"), fontSize = 19.sp); Text(tr(status("battery", !xiaomi && batteryExempt)))
            Text(tr(if (xiaomi) "应用详情 → 省电策略 → 不限制；同时允许后台自启动。" else "在应用的电池设置中允许后台运行，或取消电池优化。"), fontSize = 13.sp)
            Button(onClick = {
                val vendor = Intent().setComponent(android.content.ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
                    .putExtra("package_name", context.packageName).putExtra("package_label", "Vibe Halo")
                if (!(xiaomi && openSettings(context, vendor))) {
                    if (!openSettings(context, appSettings(context))) openSettings(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }) { Text(tr("打开省电设置")) }
            if (xiaomi) TextButton(onClick = {
                if (!openSettings(context, Intent().setComponent(android.content.ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")))) openSettings(context, appSettings(context))
            }) { Text(tr("后台自启动设置")) }
            Row { TextButton(onClick = { mark("battery", "confirmed") }) { Text(tr("我已完成")) }; TextButton(onClick = { mark("battery", "skipped") }) { Text(tr("稍后设置")) } }
        }
        HaloCard {
            Text("4 · " + tr("连接电脑"), fontSize = 19.sp)
            Text(tr(if (connected) "已配对" else "在电脑托盘打开手机伴侣，生成配对码。"))
            Button(onClick = onConnect) { Text(tr(if (connected) "连接另一台电脑" else "连接电脑")) }
        }
        Button(enabled = !required || connected, onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text(tr(if (required) "进入应用" else "完成")) }
        if (required && !connected) Text(tr("请先完成一台电脑的配对。"), fontSize = 12.sp)
    }
    if (showLock) AlertDialog(onDismissRequest = { showLock = false }, title = { Text(tr("后台锁定")) }, text = { Text(tr("打开最近任务 → 找到 Vibe Halo → 长按卡片 → 点击锁形按钮。完成后返回应用确认。此状态需要手动确认。")) }, confirmButton = { TextButton(onClick = { showLock = false }) { Text(tr("知道了")) } })
}
