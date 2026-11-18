package com.vibe.halo.mobile

import android.app.NotificationManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.notifications.CompanionNotifications
import com.vibe.halo.mobile.notifications.NotificationRetention
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

// Run seed and replay in separate instrumentation invocations to restart the
// application process, with the same synthetic notificationEvent argument.
@RunWith(AndroidJUnit4::class)
class NotificationPersistenceTest {
    // Seed, exit the app with `am kill` (not force-stop, which clears cards),
    // inspect system notifications after three minutes, then run replay.
    @Test fun nativeTimeoutSurvivesProcessExit() {
        val args = InstrumentationRegistry.getArguments()
        val phase = args.getString("notificationPhase")
        assumeTrue(phase in listOf("timeout-seed", "timeout-replay"))
        val event = requireNotNull(args.getString("notificationEvent"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val pc = "pc_timeout-persistence"; val tag = "$pc/$event"
        val data = mapOf("protocolVersion" to "1", "pcId" to pc, "eventId" to event, "eventRevision" to "1", "kind" to "completion")
        if (phase == "timeout-seed") {
            val prefs = context.getSharedPreferences("timeout-test", 0)
            prefs.edit().putInt("original-minutes", NotificationRetention.minutes(context)).commit()
            CompanionNotifications.setRetentionMinutes(context, 3)
            assertEquals("notification_posted", CompanionNotifications.show(context, data))
            val deadline = android.os.SystemClock.elapsedRealtime() + 3000
            while (manager.activeNotifications.count { it.tag?.startsWith("$pc/") == true } != 2 && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
            assertEquals(2, manager.activeNotifications.count { it.tag?.startsWith("$pc/") == true })
            assertTrue(manager.activeNotifications.filter { it.tag?.startsWith("$pc/") == true }.all { it.notification.timeoutAfter == 180_000L })
        } else {
            try {
                assertTrue(manager.activeNotifications.none { it.tag?.startsWith("$pc/") == true })
                assertTrue(context.getSharedPreferences("notification-revisions", 0).contains(tag))
                CompanionNotifications.show(context, data)
                Thread.sleep(200)
                assertTrue(manager.activeNotifications.none { it.tag?.startsWith("$pc/") == true })
            } finally {
                CompanionNotifications.setRetentionMinutes(context, context.getSharedPreferences("timeout-test", 0).getInt("original-minutes", 10))
            }
        }
    }

    @Test fun deliverySurvivesProcessRestartWithoutAnotherAlert() {
        val args = InstrumentationRegistry.getArguments()
        val phase = args.getString("notificationPhase")
        assumeTrue(phase in listOf("seed", "replay"))
        val event = requireNotNull(args.getString("notificationEvent"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val pc = "pc_persistence-test"; val tag = "$pc/$event"
        val data = mapOf("protocolVersion" to "1", "pcId" to pc, "eventId" to event, "eventRevision" to "1", "kind" to "completion", "agentId" to "codex")
        if (phase == "seed") {
            assertEquals("notification_posted", CompanionNotifications.show(context, data))
            val deadline = android.os.SystemClock.elapsedRealtime() + 3000
            while (manager.activeNotifications.none { it.tag == tag } && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
            assertTrue(manager.activeNotifications.any { it.tag == tag })
            manager.cancel(tag, 0)
        } else {
            assertTrue(context.getSharedPreferences("notification-revisions", 0).contains(tag))
            assertEquals("notification_posted", CompanionNotifications.show(context, data))
            Thread.sleep(200)
            assertFalse(manager.activeNotifications.any { it.tag == tag })
        }
    }
}
