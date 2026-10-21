package com.vibe.halo.mobile

import android.app.NotificationManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.notifications.CompanionNotifications
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

// Run seed and replay in separate instrumentation invocations to restart the
// application process, with the same synthetic notificationEvent argument.
@RunWith(AndroidJUnit4::class)
class NotificationPersistenceTest {
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
