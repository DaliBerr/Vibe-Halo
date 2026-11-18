package com.vibe.halo.mobile

import android.app.Notification
import android.app.NotificationManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.notifications.CompanionNotifications
import com.vibe.halo.mobile.notifications.NotificationRetention
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NotificationTimeoutTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = context.getSystemService(NotificationManager::class.java)
    private fun pc() = "pc_${UUID.randomUUID()}"
    private fun data(pc: String, event: String, kind: String = "completion") = mapOf(
        "protocolVersion" to "1", "pcId" to pc, "eventId" to event, "eventRevision" to "1", "kind" to kind)
    private fun cards(pc: String) = manager.activeNotifications.filter { it.tag?.startsWith("$pc/") == true }
    private fun awaitSystem(timeout: Long = 5000, predicate: () -> Boolean) {
        val deadline = android.os.SystemClock.elapsedRealtime() + timeout
        while (!predicate() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(40)
        assertTrue("System notification state did not settle", predicate())
    }
    private fun age(pc: String, event: String, ageMillis: Long) {
        // Wait for the real settings job, so fixture writes do not race it or
        // consume the platform's limited update quota alongside that batch.
        awaitSystem(30000) {
            androidx.work.WorkManager.getInstance(context).getWorkInfosForUniqueWork("notification-retention").get().all { it.state.isFinished }
        }
        val postedAt = System.currentTimeMillis() - ageMillis
        // recoverBuilder gives the notification's existing extras precedence
        // over addExtras, so alter a clone before recovering the builder.
        val deadline = android.os.SystemClock.elapsedRealtime() + 10000
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            val card = cards(pc).single { it.tag == "$pc/$event" }
            val aged = card.notification.clone().apply { extras.putLong(NotificationRetention.POSTED_AT, postedAt) }
            manager.notify(card.tag, card.id, Notification.Builder.recoverBuilder(context, aged).setOnlyAlertOnce(true).build())
            Thread.sleep(750)
            if (cards(pc).any { it.tag == card.tag && it.notification.extras.getLong(NotificationRetention.POSTED_AT) == postedAt }) return
        }
        fail("Could not age the fixture notification within Android's update quota")
    }

    @Test fun changingLifetimeUpdatesABusyNotificationShadeWithoutDroppingCards() {
        val original = NotificationRetention.minutes(context); val pc = pc()
        try {
            CompanionNotifications.setRetentionMinutes(context, 10)
            repeat(12) { CompanionNotifications.show(context, data(pc, "busy_$it")); Thread.sleep(150) }
            awaitSystem { cards(pc).size == 13 }
            CompanionNotifications.setRetentionMinutes(context, 3)
            awaitSystem(25000) { cards(pc).size == 13 && cards(pc).all { it.notification.extras.getInt(NotificationRetention.MINUTES) == 3 } }
            assertTrue(cards(pc).all { it.notification.timeoutAfter in 140_000L..180_000L })
            assertEquals(12, cards(pc).count { it.notification.flags and Notification.FLAG_LOCAL_ONLY == 0 })
        } finally { CompanionNotifications.clearPc(context, pc); CompanionNotifications.setRetentionMinutes(context, original) }
    }

    @Test fun everyCategoryAndPhoneSummaryUseSavedLifetimeWithoutResettingOnReplay() {
        val original = NotificationRetention.minutes(context); val pc = pc()
        try {
            CompanionNotifications.setRetentionMinutes(context, 10)
            listOf("completion", "plan", "approval", "question", "input").forEach { kind ->
                assertEquals("notification_posted", CompanionNotifications.show(context, data(pc, kind, kind)))
            }
            awaitSystem { cards(pc).size == 6 }
            assertTrue(cards(pc).all { it.notification.timeoutAfter in 590_000L..600_000L })
            val posted = cards(pc).single { it.tag == "$pc/completion" }.notification.extras.getLong(NotificationRetention.POSTED_AT)
            assertEquals("notification_posted", CompanionNotifications.show(context, data(pc, "completion") + ("eventRevision" to "2")))
            assertEquals(posted, cards(pc).single { it.tag == "$pc/completion" }.notification.extras.getLong(NotificationRetention.POSTED_AT))
            CompanionNotifications.setRetentionMinutes(context, 30)
            awaitSystem(12000) { cards(pc).size == 6 && cards(pc).all { it.notification.timeoutAfter in 1_780_000L..1_800_000L } }
            assertTrue(cards(pc).all { it.notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
            assertTrue(cards(pc).single { it.tag == "$pc/_summary" }.notification.flags and Notification.FLAG_LOCAL_ONLY != 0)
        } finally { CompanionNotifications.clearPc(context, pc); CompanionNotifications.setRetentionMinutes(context, original) }
    }

    @Test fun nativeTimeoutRemovesEachCardAndLastSummaryWithoutTouchingOtherComputerOrReappearing() {
        val original = NotificationRetention.minutes(context); val pc = pc(); val other = pc()
        try {
            CompanionNotifications.setRetentionMinutes(context, 3)
            CompanionNotifications.show(context, data(pc, "older")); CompanionNotifications.show(context, data(pc, "younger"))
            CompanionNotifications.show(context, data(other, "retained"))
            awaitSystem { cards(pc).size == 3 && cards(other).size == 2 }
            age(pc, "older", 176_000); age(pc, "younger", 170_000)
            kotlinx.coroutines.runBlocking { CompanionNotifications.refreshTimeouts(context) }
            awaitSystem { cards(pc).single { it.tag == "$pc/_summary" }.notification.timeoutAfter in 1L..10000L }
            awaitSystem(5000) { cards(pc).none { it.tag == "$pc/older" } }
            assertTrue(cards(pc).any { it.tag == "$pc/younger" })
            assertTrue(cards(pc).any { it.tag == "$pc/_summary" })
            awaitSystem(12000) { cards(pc).isEmpty() }
            assertEquals(2, cards(other).size)
            CompanionNotifications.show(context, data(pc, "older") + ("eventRevision" to "2"))
            CompanionNotifications.show(context, data(pc, "younger") + ("eventRevision" to "2"))
            assertTrue(cards(pc).isEmpty())
        } finally { CompanionNotifications.clearPc(context, pc); CompanionNotifications.clearPc(context, other); CompanionNotifications.setRetentionMinutes(context, original) }
    }

    @Test fun shorteningLifetimeExpiresOldCardsAndUpgradesLegacyCardsByOriginalPostTime() {
        val original = NotificationRetention.minutes(context); val pc = pc()
        try {
            CompanionNotifications.setRetentionMinutes(context, 10)
            CompanionNotifications.show(context, data(pc, "old"))
            awaitSystem { cards(pc).size == 2 }
            age(pc, "old", 240_000)
            manager.notify("$pc/legacy", 0, Notification.Builder(context, "completions").setSmallIcon(R.drawable.ic_halo).setContentTitle("Legacy").build())
            awaitSystem { cards(pc).size == 3 }
            CompanionNotifications.setRetentionMinutes(context, 3)
            awaitSystem(12000) { cards(pc).size == 2 && cards(pc).all { it.notification.timeoutAfter in 160_000L..180_000L } }
            assertTrue(cards(pc).none { it.tag == "$pc/old" })
            assertEquals("suppressed_by_user", CompanionNotifications.show(context, data(pc, "old")))
            val legacy = cards(pc).single { it.tag == "$pc/legacy" }
            assertTrue(legacy.notification.extras.getLong(NotificationRetention.POSTED_AT) > 0)
            kotlinx.coroutines.runBlocking { CompanionNotifications.refreshTimeouts(context) }
            awaitSystem { cards(pc).single { it.tag == "$pc/legacy" }.notification.extras.getLong(NotificationRetention.POSTED_AT) == legacy.notification.extras.getLong(NotificationRetention.POSTED_AT) }
            for (invalid in listOf(2, 31)) assertTrue(runCatching { CompanionNotifications.setRetentionMinutes(context, invalid) }.isFailure)
            assertEquals(3, NotificationRetention.minutes(context))
            age(pc, "legacy", 240_000)
            CompanionNotifications.setRetentionMinutes(context, 3)
            awaitSystem(12000) { cards(pc).isEmpty() }
            assertEquals("suppressed_by_user", CompanionNotifications.show(context, data(pc, "legacy")))
        } finally { CompanionNotifications.clearPc(context, pc); CompanionNotifications.setRetentionMinutes(context, original) }
    }
}
