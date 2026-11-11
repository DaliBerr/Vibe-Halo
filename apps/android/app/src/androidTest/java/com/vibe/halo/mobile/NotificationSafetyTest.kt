package com.vibe.halo.mobile

import android.app.NotificationManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.notifications.CompanionNotifications
import com.vibe.halo.mobile.notifications.CompanionNotificationDismissedReceiver
import com.vibe.halo.mobile.notifications.NotificationPreview
import android.app.Notification
import android.content.Intent
import org.json.JSONObject
import org.json.JSONArray
import com.vibe.halo.mobile.security.DeviceCrypto
import com.vibe.halo.mobile.security.SecureStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NotificationSafetyTest {
    @Test fun groupedEventsHaveOnePhoneOnlySilentSummaryAndOneWatchCardPerEvent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val pc = "pc_${UUID.randomUUID()}"
        val group = "vibe-halo-$pc"
        val events = (0..4).map { "evt_${UUID.randomUUID()}" }
        try {
            events.forEachIndexed { index, event ->
                val kind = listOf("completion", "plan", "approval", "question", "input")[index]
                val data = mapOf("protocolVersion" to "1", "pcId" to pc, "eventId" to event, "eventRevision" to "1", "kind" to kind)
                assertEquals("notification_posted", CompanionNotifications.show(context, data, NotificationPreview("Codex", "任务 $index", "已完成 $index")))
                assertEquals("notification_posted", CompanionNotifications.show(context, data + ("eventRevision" to "2")))
            }
            awaitSystem { manager.activeNotifications.count { it.notification.group == group } == events.size + 1 }
            val cards = manager.activeNotifications.filter { it.notification.group == group }
            val summaries = cards.filter { it.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0 }
            assertEquals("An explicit summary prevents a system/OEM summary from duplicating a task on watches", 1, summaries.size)
            val summary = summaries.single().notification
            assertTrue(summary.flags and Notification.FLAG_LOCAL_ONLY != 0)
            assertEquals(Notification.GROUP_ALERT_CHILDREN, summary.groupAlertBehavior)
            assertEquals("Vibe Halo", summary.extras.getString(Notification.EXTRA_TITLE))
            assertFalse(summary.extras.getString(Notification.EXTRA_TEXT).orEmpty().contains("已完成"))
            assertTrue(summary.actions.isNullOrEmpty())
            val mirrorable = cards.filter { it.notification.flags and Notification.FLAG_LOCAL_ONLY == 0 }
            assertEquals(events.size, mirrorable.size)
            assertEquals(events.map { "$pc/$it" }.toSet(), mirrorable.map { it.tag }.toSet())
            assertTrue(mirrorable.all { it.notification.groupAlertBehavior == Notification.GROUP_ALERT_CHILDREN })
            events.forEach { CompanionNotifications.clearEvent(context, pc, it, 3) }
            awaitSystem { manager.activeNotifications.none { it.notification.group == group } }
        } finally { CompanionNotifications.clearPc(context, pc) }
    }

    @Test fun dismissingOpeningAndClearingEventsRemoveOnlyTheirComputersSummary() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val pc = "pc_${UUID.randomUUID()}"; val otherPc = "pc_${UUID.randomUUID()}"
        val event = "evt_${UUID.randomUUID()}"; val next = "evt_${UUID.randomUUID()}"
        fun post(computer: String, id: String) = CompanionNotifications.show(context, mapOf("protocolVersion" to "1", "pcId" to computer,
            "eventId" to id, "eventRevision" to "1", "kind" to "completion"))
        fun cards(computer: String) = manager.activeNotifications.filter { it.notification.group == "vibe-halo-$computer" }
        try {
            post(pc, event); post(otherPc, event)
            awaitSystem { cards(pc).size == 2 && cards(otherPc).size == 2 }
            // The delete PendingIntent works without an Activity or a running app.
            val deleteIntent = manager.activeNotifications.single { it.tag == "$pc/$event" }.notification.deleteIntent
            assertNotNull(deleteIntent)
            deleteIntent.send()
            awaitSystem { cards(pc).isEmpty() }
            assertEquals(2, cards(otherPc).size)
            assertEquals("suppressed_by_user", post(pc, event))
            assertTrue(cards(pc).isEmpty())
            post(pc, next)
            awaitSystem { cards(pc).size == 2 }
            // Opening a task uses the same removal path after routing its detail.
            CompanionNotifications.dismissEvent(context, pc, next)
            awaitSystem { cards(pc).isEmpty() }
            CompanionNotificationDismissedReceiver().onReceive(context, Intent().putExtra("pcId", otherPc).putExtra("eventId", "../_summary"))
            assertEquals(2, cards(otherPc).size)
            val unknown = "evt_${UUID.randomUUID()}"
            CompanionNotifications.dismissEvent(context, otherPc, unknown)
            assertFalse(context.getSharedPreferences("notification-revisions", 0).contains("$otherPc/$unknown"))
            CompanionNotifications.clearPc(context, otherPc)
            awaitSystem { cards(otherPc).isEmpty() }
        } finally { CompanionNotifications.clearPc(context, pc); CompanionNotifications.clearPc(context, otherPc) }
    }


    @Test fun notificationCopyFollowsAppLanguageAndDistinguishesNativeInput() {
        val original = UiLanguage.mode
        try {
            UiLanguage.mode = "en-US"
            for (kind in listOf("approval", "question", "input", "plan", "completion")) {
                val (title, body) = CompanionNotifications.copy(kind)
                assertFalse(Regex("[\\u4e00-\\u9fff]").containsMatchIn(title + body))
            }
            assertTrue(CompanionNotifications.copy("input").second.contains("original app"))
            UiLanguage.mode = "zh-CN"
            assertEquals("需要审批", CompanionNotifications.copy("approval").first)
            assertEquals("任务已完成", CompanionNotifications.copy("completion").first)
            assertTrue(CompanionNotifications.copy("input").second.contains("原应用"))
            assertTrue(CompanionNotifications.copy("question").second.contains("Vibe Halo"))
        } finally { UiLanguage.mode = original }
    }
    @Test fun notificationIsReadOnlyAndDeduplicated() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val pc = "pc_${UUID.randomUUID()}"; val event = "evt_${UUID.randomUUID()}"
        val data = mapOf("protocolVersion" to "1", "pcId" to pc, "pcSessionEpoch" to UUID.randomUUID().toString(), "eventId" to event, "eventRevision" to "1", "kind" to "approval")
        assertEquals("notification_posted", CompanionNotifications.show(context, data))
        assertEquals("notification_posted", CompanionNotifications.show(context, data))
        // System notification publication is asynchronous to the app's notify().
        awaitSystem { manager.activeNotifications.any { it.tag == "$pc/$event" } }
        val notifications = manager.activeNotifications.filter { it.tag == "$pc/$event" }
        assertEquals(1, notifications.size)
        val notification = notifications.single().notification
        assertTrue(notification.actions.isNullOrEmpty())
        assertNotNull(notification.contentIntent)
        assertNull(notification.fullScreenIntent)
        assertEquals("approvals", notification.channelId)
        assertFalse(notification.allowSystemGeneratedContextualActions)
        manager.notify("$pc/$event", 1, notification) // Legacy foreground ID.
        awaitSystem { manager.activeNotifications.count { it.tag == "$pc/$event" } == 2 }
        CompanionNotifications.clearEvent(context, pc, event, 2)
        assertEquals("suppressed_by_user", CompanionNotifications.show(context, data))
        awaitSystem { manager.activeNotifications.none { it.tag == "$pc/$event" } }
        assertFalse(manager.activeNotifications.any { it.tag == "$pc/$event" })
        assertEquals("invalid", CompanionNotifications.show(context, data + ("optionId" to "allow")))
    }
    @Test fun lanAndPushRaceAlertsOnceAndNeverResurrectsDismissedOrRevisedEvents() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val pc = "pc_${UUID.randomUUID()}"; val event = "evt_${UUID.randomUUID()}"; val tag = "$pc/$event"
        val data = mapOf("protocolVersion" to "1", "pcId" to pc, "pcSessionEpoch" to UUID.randomUUID().toString(), "eventId" to event, "eventRevision" to "1", "kind" to "completion", "agentId" to "codex")
        val start = java.util.concurrent.CountDownLatch(1)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(8)
        try {
            val calls = (0..7).map { pool.submit<String> { start.await(); CompanionNotifications.show(context, data, NotificationPreview("Codex", "演示项目", "已修复重复提醒")) } }
            start.countDown(); calls.forEach { assertEquals("notification_posted", it.get()) }
            awaitSystem { manager.activeNotifications.any { it.tag == tag } }
            val cards = manager.activeNotifications.filter { it.tag == tag }
            assertEquals(1, cards.size); assertEquals(0, cards.single().id)
            assertTrue(cards.single().notification.extras.getString(Notification.EXTRA_TITLE)!!.contains("Codex"))
            assertEquals("演示项目 — 已修复重复提醒", cards.single().notification.extras.getString(Notification.EXTRA_TEXT))
            manager.cancel(tag, 0)
            awaitSystem { manager.activeNotifications.none { it.tag == tag } }
            assertEquals("notification_posted", CompanionNotifications.show(context, data + ("eventRevision" to "2")))
            assertFalse(manager.activeNotifications.any { it.tag == tag })
            CompanionNotifications.clearEvent(context, pc, event, 3)
            assertEquals("suppressed_by_user", CompanionNotifications.show(context, data + ("eventRevision" to "4")))
        } finally { pool.shutdownNow(); CompanionNotifications.clearPc(context, pc) }
    }
    @Test fun existingFirebaseCardDoesNotProduceAnotherLocalNotification() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val pc = "pc_${UUID.randomUUID()}"; val event = "evt_${UUID.randomUUID()}"; val tag = "$pc/$event"
        val data = mapOf("protocolVersion" to "1", "pcId" to pc, "eventId" to event, "eventRevision" to "1", "kind" to "completion")
        CompanionNotifications.channels(context)
        manager.notify(tag, 0, Notification.Builder(context, "completions").setSmallIcon(R.drawable.ic_halo).setContentTitle("existing Firebase card").build())
        awaitSystem { manager.activeNotifications.any { it.tag == tag } }
        assertEquals("notification_posted", CompanionNotifications.show(context, data))
        val card = manager.activeNotifications.single { it.tag == tag }
        assertEquals("existing Firebase card", card.notification.extras.getString(Notification.EXTRA_TITLE))
        CompanionNotifications.clearPc(context, pc)
    }
    @Test fun previewsSummarizeToolsQuestionsAndUnicodeWithoutSecrets() {
        fun detail(kind: String) = JSONObject().put("summary", JSONObject().put("agentId", "codex").put("kind", kind))
        val approval = NotificationPreview.fromDetail(detail("approval").put("toolName", "Bash").put("toolInputText", """{"command":"npm test"}"""))
        assertEquals("Bash · npm test", approval.text)
        assertEquals("Codex", approval.agent)
        val completed = NotificationPreview.fromDetail(detail("completion").put("description", "项目").put("toolInputText", "## Fixed **notifications**\n[Details](https://example.invalid)"))
        assertEquals("Fixed notifications Details", completed.text)
        assertEquals("项目", completed.context)
        assertEquals("😀".repeat(159) + "…", NotificationPreview.snippet("😀".repeat(200), 160))
        assertFalse(NotificationPreview.snippet("api_key=supersecretvalue", 160).contains("supersecretvalue"))
        assertFalse(NotificationPreview.snippet("Authorization: Bearer supersecretvalue", 160).contains("supersecretvalue"))
        assertFalse(NotificationPreview.snippet("""{"api_key":"supersecretvalue"}""", 160).contains("supersecretvalue"))
    }
    @Test fun encryptedPushPreviewsRequireCurrentBindingSignatureAndExactEvent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val origin = "https://notification-${UUID.randomUUID()}.invalid"
        val registry = SecureStore(context); val original = registry.read()
        val store = SecureStore(context, origin); val mobile = DeviceCrypto(context, store)
        val sender = DeviceCrypto(context, SecureStore(context, "$origin/sender"))
        val pc = JSONObject(sender.publicDevice.toString()).put("deviceId", "pc_${UUID.randomUUID()}").put("kind", "pc")
        val grant = JSONObject().put("relayOrigin", origin).put("bindingId", UUID.randomUUID().toString()).put("revision", 1)
            .put("pc", pc).put("mobile", mobile.publicDevice).put("scopes", JSONArray(listOf("events.read")))
        val record = JSONObject().put("grant", grant).put("grantJws", sender.sign(grant, "binding-grant")).put("state", "active")
        val payload = JSONObject().put("protocolVersion", 1).put("relayOrigin", origin).put("mobileId", mobile.publicDevice.getString("deviceId"))
            .put("bindingId", grant.getString("bindingId")).put("bindingRevision", 1).put("pcId", pc.getString("deviceId"))
            .put("eventId", "evt_${UUID.randomUUID()}").put("eventRevision", 1).put("pcSessionEpoch", UUID.randomUUID().toString())
            .put("kind", "completion").put("expiresAt", java.time.Instant.now().plusSeconds(120).toString())
            .put("preview", JSONObject().put("agent", "Codex").put("context", "项目").put("text", "修复完成"))
        val metadata = listOf("protocolVersion", "pcId", "eventId", "eventRevision", "pcSessionEpoch", "kind", "expiresAt").associateWith { payload.get(it).toString() }
        val envelope = sender.seal(payload, mobile.publicDevice.getJSONObject("encryptionKey"), "notification-preview")
        try {
            registry.update { it.put("origins", JSONArray(listOf(origin))) }
            store.update { it.put("bindings", JSONArray(listOf(record))) }
            assertEquals(NotificationPreview("Codex", "项目", "修复完成"), NotificationPreview.decrypt(context, metadata + ("preview" to envelope)))
            val otherOrigin = "$origin/previous"
            val otherStore = SecureStore(context, otherOrigin); val otherPhone = DeviceCrypto(context, otherStore)
            val otherGrant = JSONObject(grant.toString()).put("relayOrigin", otherOrigin).put("mobile", otherPhone.publicDevice)
            otherStore.update { it.put("bindings", JSONArray(listOf(JSONObject().put("grant", otherGrant).put("grantJws", sender.sign(otherGrant, "binding-grant")).put("state", "active")))) }
            registry.update { it.put("origins", JSONArray(listOf(otherOrigin, origin))) }
            assertEquals("修复完成", NotificationPreview.decrypt(context, metadata + ("preview" to envelope))?.text)
            for (key in listOf("pcId", "eventId", "eventRevision", "pcSessionEpoch", "kind", "expiresAt")) {
                assertTrue(key, runCatching { NotificationPreview.decrypt(context, metadata + (key to "wrong") + ("preview" to envelope)) }.isFailure)
            }
            val wrongPurpose = sender.seal(payload, mobile.publicDevice.getJSONObject("encryptionKey"), "message")
            assertTrue(runCatching { NotificationPreview.decrypt(context, metadata + ("preview" to wrongPurpose)) }.isFailure)
            payload.put("bindingRevision", 2)
            val stale = sender.seal(payload, mobile.publicDevice.getJSONObject("encryptionKey"), "notification-preview")
            assertTrue(runCatching { NotificationPreview.decrypt(context, metadata + ("preview" to stale)) }.isFailure)
            record.put("state", "revoked"); store.update { it.put("bindings", JSONArray(listOf(record))) }
            assertTrue(runCatching { NotificationPreview.decrypt(context, metadata + ("preview" to envelope)) }.isFailure)
        } finally { registry.write(original) }
    }
    private fun awaitSystem(predicate: () -> Boolean) {
        val deadline = android.os.SystemClock.elapsedRealtime() + 3000
        while (!predicate() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
        assertTrue("System notification state did not settle", predicate())
    }
}
