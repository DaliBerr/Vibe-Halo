package com.vibe.halo.mobile.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.vibe.halo.mobile.MainActivity
import com.vibe.halo.mobile.R
import com.vibe.halo.mobile.tr
import com.vibe.halo.mobile.security.SecureStore

object CompanionNotifications {
    fun copy(kind: String): Pair<String, String> {
        val english = com.vibe.halo.mobile.UiLanguage.resolvedLocale() == "en-US"
        return when (kind) {
            "approval" -> if (english) "Approval needed" to "Open Vibe Halo to review and respond." else "需要审批" to "请打开 Vibe Halo 查看并处理。"
            "question" -> if (english) "Answer needed" to "Open Vibe Halo to view the options and answer." else "有问题等待回答" to "请打开 Vibe Halo 查看选项并回答。"
            "input" -> if (english) "Choice or answer needed" to "Return to the original app on your computer to respond." else "需要选择或回答" to "请回到电脑上的原应用完成选择或回答。"
            "plan" -> if (english) "Plan ready" to "Open Vibe Halo to view the plan." else "计划已准备好" to "请打开 Vibe Halo 查看计划。"
            else -> if (english) "Task completed" to "Open Vibe Halo to view the completion update." else "任务已完成" to "请打开 Vibe Halo 查看完成消息。"
        }
    }
    fun channels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(listOf(
            NotificationChannel("approvals", tr("审批提醒"), NotificationManager.IMPORTANCE_HIGH).apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE },
            NotificationChannel("questions", tr("输入与回答提醒"), NotificationManager.IMPORTANCE_HIGH).apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE },
            NotificationChannel("completions", tr("完成与计划就绪"), NotificationManager.IMPORTANCE_DEFAULT).apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE },
            NotificationChannel("connection_status", tr("连接状态"), NotificationManager.IMPORTANCE_LOW)
        ))
    }
    fun show(context: Context, data: Map<String, String>): String {
        if (data.keys.any { it !in setOf("protocolVersion", "pcId", "pcSessionEpoch", "eventId", "eventRevision", "kind") } || data["protocolVersion"] != "1") return "invalid"
        val pcId = data["pcId"] ?: return "invalid"; val eventId = data["eventId"] ?: return "invalid"
        val revision = data["eventRevision"]?.toLongOrNull()?.takeIf { it > 0 } ?: return "invalid"
        if (!Regex("pc_[A-Za-z0-9-]{1,80}").matches(pcId) || !Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}").matches(eventId)) return "invalid"
        val kind = data["kind"]?.takeIf { it in listOf("approval", "question", "input", "plan", "completion") } ?: return "invalid"
        if (context.getSharedPreferences("notification-preferences", Context.MODE_PRIVATE).getBoolean("$pcId:muted", false)) return "suppressed_by_user"
        val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
        val key = "$pcId/$eventId"
        if (seen.getLong(key, 0) >= revision) return if (seen.getBoolean("$key:posted", false)) "notification_posted" else "suppressed_by_user"
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled() || Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "suppressed_by_user"
        channels(context)
        val channel = if (kind in listOf("completion", "plan")) "completions" else if (kind == "approval") "approvals" else "questions"
        if (manager.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE) return "suppressed_by_user"
        val (title, body) = copy(kind)
        val intent = Intent(context, MainActivity::class.java).setAction("com.vibe.halo.mobile.OPEN_EVENT").putExtra("pcId", pcId).putExtra("eventId", eventId).putExtra("pcSessionEpoch", data["pcSessionEpoch"])
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, key.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_halo).setContentTitle(title)
            .setContentText(body).setContentIntent(pending).setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setOnlyAlertOnce(true).setCategory(if (channel != "completions") Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
            .setGroup("vibe-halo-$pcId")
        if (Build.VERSION.SDK_INT >= 29) builder.setAllowSystemGeneratedContextualActions(false)
        val notification = builder.build()
        // No decision action, inline reply, full-screen intent, or custom watch UI.
        context.getSystemService(NotificationManager::class.java).notify(key, 1, notification)
        val editor = seen.edit(); if (seen.all.size >= 1000) editor.clear(); editor.putLong(key, revision).putBoolean("$key:posted", true).apply()
        return "notification_posted"
    }
    fun clearEvent(context: Context, pcId: String, eventId: String, revision: Long) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val tag = "$pcId/$eventId"
        manager.cancel(tag, 1)
        // FCM's background auto-display uses its own notification ID (currently
        // zero). Cancel matching active tags, not only our foreground builder ID.
        manager.activeNotifications.filter { it.tag == tag }.forEach { manager.cancel(it.tag, it.id) }
        val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
        val editor = seen.edit(); if (seen.all.size >= 1000) editor.clear(); editor.putLong("$pcId/$eventId", revision).putBoolean("$pcId/$eventId:posted", false).apply()
    }
    fun clearPc(context: Context, pcId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag?.startsWith("$pcId/") == true }.forEach { manager.cancel(it.tag, it.id) }
    }
}
class CompanionMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) { CompanionNotifications.show(this, message.data) }
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        runCatching { SecureStore(this).update { it.put("pushToken", token) }; TokenMaintenance.enqueue(this) }
    }
}
