package com.vibe.halo.mobile.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
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
import kotlinx.coroutines.delay

object CompanionNotifications {
    private fun groupKey(pcId: String) = "vibe-halo-$pcId"
    // The leading underscore cannot be an event ID, so this cannot replace a task.
    private fun summaryTag(pcId: String) = "$pcId/_summary"

    private fun showPhoneSummary(context: Context, pcId: String, channel: String, timeoutMillis: Long) {
        val tag = summaryTag(pcId)
        val intent = Intent(context, MainActivity::class.java).setAction("com.vibe.halo.mobile.OPEN_NOTIFICATIONS")
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, tag.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val english = com.vibe.halo.mobile.UiLanguage.resolvedLocale() == "en-US"
        val summary = Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_halo)
            .setContentTitle("Vibe Halo").setContentText(if (english) "Open Vibe Halo to view notifications." else "打开 Vibe Halo 查看通知。")
            .setContentIntent(pending).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setGroup(groupKey(pcId)).setGroupSummary(true).setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .setLocalOnly(true).setOnlyAlertOnce(true).setTimeoutAfter(timeoutMillis)
            .addExtras(android.os.Bundle().apply { putInt(NotificationRetention.MINUTES, NotificationRetention.minutes(context)) })
        if (Build.VERSION.SDK_INT >= 29) summary.setAllowSystemGeneratedContextualActions(false)
        // Explicitly own the summary: system/OEM summaries may clone the latest
        // task and be bridged to a watch alongside the real event notification.
        context.getSystemService(NotificationManager::class.java).notify(tag, 0, summary.build())
    }

    @Synchronized
    fun setRetentionMinutes(context: Context, minutes: Int) {
        NotificationRetention.save(context, minutes)
        NotificationRetention.enqueueRefresh(context, replace = true)
    }

    /** Also migrates cards from older versions. Never restart a card's original age. */
    suspend fun refreshTimeouts(context: Context, onlyChanged: Boolean = false) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val groups = manager.activeNotifications.filter {
            it.tag?.matches(Regex("pc_[A-Za-z0-9-]{1,80}/[A-Za-z0-9_][A-Za-z0-9_.:-]{0,239}")) == true
        }.groupBy { it.tag!!.substringBefore('/') }
        for ((pcId, cards) in groups) {
            val now = System.currentTimeMillis()
            val minutes = NotificationRetention.minutes(context)
            if (onlyChanged && cards.all {
                it.notification.extras.getInt(NotificationRetention.MINUTES) == minutes &&
                    (it.tag == summaryTag(pcId) || it.notification.extras.containsKey(NotificationRetention.POSTED_AT) &&
                        NotificationRetention.remainingMillis(it.notification.extras.getLong(NotificationRetention.POSTED_AT), now, minutes) > 0)
            }) continue
            synchronized(this) { refreshPhoneSummary(context, pcId) }
            delay(500)
            for (card in cards.filter { it.tag != summaryTag(pcId) }) {
                synchronized(this) {
                    // A user may have opened/dismissed the card while this job waited.
                    val current = manager.activeNotifications.find { it.tag == card.tag && it.id == card.id }
                    if (current == null || current.postTime != card.postTime) return@synchronized
                    val now = System.currentTimeMillis()
                    val minutes = NotificationRetention.minutes(context)
                    val postedAt = card.notification.extras.getLong(NotificationRetention.POSTED_AT, card.postTime)
                    val timeout = NotificationRetention.remainingMillis(postedAt, now, minutes)
                    if (timeout == 0L) {
                        manager.cancel(card.tag, card.id)
                        val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
                        remember(context, card.tag!!, seen.getLong(card.tag, 1), false)
                    } else {
                        val updated = card.notification.clone().apply { extras.putAll(NotificationRetention.extras(postedAt, minutes)) }
                        val builder = Notification.Builder.recoverBuilder(context, updated)
                            .setTimeoutAfter(timeout).setOnlyAlertOnce(true)
                        manager.notify(card.tag, card.id, builder.build())
                    }
                }
                // Android drops rapid updates to existing notifications. Do not
                // hold the publisher lock or block the UI while pacing this batch.
                delay(500)
            }
            synchronized(this) { refreshPhoneSummary(context, pcId) }
            delay(500)
        }
    }

    private fun refreshPhoneSummary(context: Context, pcId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val now = System.currentTimeMillis()
        val minutes = NotificationRetention.minutes(context)
        val cards = manager.activeNotifications.filter { it.tag?.startsWith("$pcId/") == true && it.tag != summaryTag(pcId) }
        val latest = cards
            .map { it to NotificationRetention.remainingMillis(it.notification.extras.getLong(NotificationRetention.POSTED_AT, it.postTime), now, minutes) }
            .filter { it.second > 0 }.maxByOrNull { it.second }
        // Canceling a summary cancels its children: cover the youngest card.
        if (latest == null) {
            // Mark even legacy cards before summary cancellation removes them.
            // Otherwise a delayed cloud copy could recreate an untracked card.
            val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
            cards.forEach { remember(context, it.tag!!, seen.getLong(it.tag, 1), false); manager.cancel(it.tag, it.id) }
            manager.cancel(summaryTag(pcId), 0)
        }
        else showPhoneSummary(context, pcId, latest.first.notification.channelId, latest.second)
    }

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
    @Synchronized
    fun show(context: Context, data: Map<String, String>, preview: NotificationPreview? = null, transport: String = "unknown"): String {
        val timingStart = android.os.SystemClock.elapsedRealtime()
        NotificationTiming.record("android_show_start", data, transport)
        if (data.keys.any { it !in setOf("protocolVersion", "pcId", "pcSessionEpoch", "eventId", "eventRevision", "kind", "agentId", "expiresAt") } || data["protocolVersion"] != "1") return "invalid"
        val pcId = data["pcId"] ?: return "invalid"; val eventId = data["eventId"] ?: return "invalid"
        val revision = data["eventRevision"]?.toLongOrNull()?.takeIf { it > 0 } ?: return "invalid"
        if (!Regex("pc_[A-Za-z0-9-]{1,80}").matches(pcId) || !Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}").matches(eventId)) return "invalid"
        val kind = data["kind"]?.takeIf { it in listOf("approval", "question", "input", "plan", "completion") } ?: return "invalid"
        if (data.containsKey("expiresAt") && (runCatching { java.time.Instant.parse(data.getValue("expiresAt")).toEpochMilli() }.getOrNull() ?: 0) <= System.currentTimeMillis()) return "expired"
        if (context.getSharedPreferences("notification-preferences", Context.MODE_PRIVATE).getBoolean("$pcId:muted", false)) return "suppressed_by_user"
        val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
        val key = "$pcId/$eventId"
        // One alert per event across LAN, foreground/background FCM, revisions,
        // retries and process restarts. Dismissing a card must not resurrect it.
        if (seen.contains(key)) return if (seen.getBoolean("$key:posted", false)) "notification_posted" else "suppressed_by_user"
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.activeNotifications.any { it.tag == key }) {
            remember(context, key, revision, true)
            return "notification_posted"
        }
        if (!manager.areNotificationsEnabled() || Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "suppressed_by_user"
        channels(context)
        val channel = if (kind in listOf("completion", "plan")) "completions" else if (kind == "approval") "approvals" else "questions"
        if (manager.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE) return "suppressed_by_user"
        val (fallbackTitle, fallbackBody) = copy(kind)
        val client = preview?.agent ?: NotificationPreview.agentName(data["agentId"].orEmpty())
        val title = if (client.isBlank()) fallbackTitle else "$client · $fallbackTitle"
        val body = preview?.let { listOf(it.context, it.text).filter { part -> part.isNotBlank() }.joinToString(" — ") }?.takeIf { it.isNotBlank() } ?: fallbackBody
        val intent = Intent(context, MainActivity::class.java).setAction("com.vibe.halo.mobile.OPEN_EVENT").putExtra("pcId", pcId).putExtra("eventId", eventId).putExtra("pcSessionEpoch", data["pcSessionEpoch"])
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, key.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val dismissed = Intent(context, CompanionNotificationDismissedReceiver::class.java).setAction(key)
            .putExtra("pcId", pcId).putExtra("eventId", eventId)
        val deleteIntent = PendingIntent.getBroadcast(context, key.hashCode(), dismissed, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val timeout = NotificationRetention.durationMillis(NotificationRetention.minutes(context))
        val builder = Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_halo).setContentTitle(title)
            .setContentText(body).setStyle(Notification.BigTextStyle().bigText(body)).setContentIntent(pending).setDeleteIntent(deleteIntent).setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setOnlyAlertOnce(true).setCategory(if (channel != "completions") Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
            .setGroup(groupKey(pcId)).setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .addExtras(NotificationRetention.extras(System.currentTimeMillis(), NotificationRetention.minutes(context))).setTimeoutAfter(timeout)
        NotificationAppearance.apply(context, builder, data["agentId"], client, title, body)
        if (Build.VERSION.SDK_INT >= 29) builder.setAllowSystemGeneratedContextualActions(false)
        val notification = builder.build()
        // No decision action, inline reply, full-screen intent, or custom watch UI.
        showPhoneSummary(context, pcId, channel, timeout)
        context.getSystemService(NotificationManager::class.java).notify(key, 0, notification)
        NotificationTiming.record("android_notify_returned", data, transport, timingStart)
        remember(context, key, revision, true)
        return "notification_posted"
    }
    @Synchronized
    fun clearEvent(context: Context, pcId: String, eventId: String, revision: Long) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val tag = "$pcId/$eventId"
        manager.cancel(tag, 0)
        manager.cancel(tag, 1)
        // FCM's background auto-display uses its own notification ID (currently
        // zero). Cancel matching active tags, not only our foreground builder ID.
        manager.activeNotifications.filter { it.tag == tag }.forEach { manager.cancel(it.tag, it.id) }
        remember(context, tag, revision, false)
        val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
        // cancel() and activeNotifications can race. Ignore every already-cleared
        // marker as well as this tag so back-to-back clears remove the summary.
        val remaining = manager.activeNotifications.any {
            it.tag?.startsWith("$pcId/") == true && it.tag != tag && it.tag != summaryTag(pcId)
                && (!seen.contains(it.tag) || seen.getBoolean("${it.tag}:posted", false))
        }
        if (!remaining) manager.cancel(summaryTag(pcId), 0)
    }
    @Synchronized
    fun dismissEvent(context: Context, pcId: String, eventId: String) {
        if (!Regex("pc_[A-Za-z0-9-]{1,80}").matches(pcId) || !Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}").matches(eventId)) return
        val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
        val key = "$pcId/$eventId"
        // MainActivity is exported. An arbitrary launch intent must not seed
        // unknown dismissal markers or evict legitimate deduplication entries.
        if (!seen.contains(key) && context.getSystemService(NotificationManager::class.java).activeNotifications.none { it.tag == key }) return
        clearEvent(context, pcId, eventId, seen.getLong(key, 1))
    }
    private fun remember(context: Context, key: String, revision: Long, posted: Boolean) {
        val seen = context.getSharedPreferences("notification-revisions", Context.MODE_PRIVATE)
        val editor = seen.edit()
        val keys = seen.all.filterValues { it is Long }.keys.filter { !it.endsWith(":time") && it != key }
        // Evict oldest individual entries, never wipe every dedup marker at once.
        keys.sortedBy { seen.getLong("$it:time", 0) }.take((keys.size - 999).coerceAtLeast(0)).forEach {
            editor.remove(it).remove("$it:posted").remove("$it:time")
        }
        editor.putLong(key, maxOf(revision, seen.getLong(key, 0))).putBoolean("$key:posted", posted).putLong("$key:time", System.currentTimeMillis()).commit()
    }
    @Synchronized
    fun clearPc(context: Context, pcId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag?.startsWith("$pcId/") == true }.forEach { manager.cancel(it.tag, it.id) }
        manager.cancel(summaryTag(pcId), 0)
    }
}
class CompanionNotificationDismissedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pcId = intent.getStringExtra("pcId") ?: return
        val eventId = intent.getStringExtra("eventId") ?: return
        CompanionNotifications.dismissEvent(context, pcId, eventId)
    }
}
class CompanionMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val timingStart = android.os.SystemClock.elapsedRealtime()
        NotificationTiming.record("android_fcm_received", message.data, "fcm")
        runCatching {
            val preview = NotificationPreview.decrypt(this, message.data)
            NotificationTiming.record("android_decrypted", message.data, "fcm", timingStart)
            if (message.data["notificationAction"] == "dismiss") {
                require(preview?.dismiss == true)
                val target = requireNotNull(com.vibe.halo.mobile.data.NotificationSyncTarget.from(message.data))
                CompanionNotifications.clearEvent(this, target.pcId, target.eventId, target.revision)
                NotificationSync.enqueue(this, message.data, message.priority == RemoteMessage.PRIORITY_HIGH)
                return
            }
            val result = CompanionNotifications.show(this, message.data - "preview", preview, "fcm")
            NotificationTiming.record("android_result_$result", message.data, "fcm", timingStart)
            if (result in setOf("notification_posted", "suppressed_by_user")) {
                NotificationSync.enqueue(this, message.data, message.priority == RemoteMessage.PRIORITY_HIGH)
            }
        }.onFailure { NotificationTiming.record("android_processing_failed", message.data, "fcm", timingStart) }
    }
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        runCatching { SecureStore(this).update { it.put("pushToken", token) }; TokenMaintenance.enqueue(this) }
    }
}
