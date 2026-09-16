package com.vibe.halo.mobile

import android.app.NotificationManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.notifications.CompanionNotifications
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NotificationSafetyTest {
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
        CompanionNotifications.clearEvent(context, pc, event, 2)
        assertEquals("suppressed_by_user", CompanionNotifications.show(context, data))
        awaitSystem { manager.activeNotifications.none { it.tag == "$pc/$event" } }
        assertFalse(manager.activeNotifications.any { it.tag == "$pc/$event" })
        assertEquals("invalid", CompanionNotifications.show(context, data + ("optionId" to "allow")))
    }
    private fun awaitSystem(predicate: () -> Boolean) {
        val deadline = android.os.SystemClock.elapsedRealtime() + 3000
        while (!predicate() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
        assertTrue("System notification state did not settle", predicate())
    }
}
