package com.vibe.halo.mobile.notifications

import org.junit.Assert.*
import org.junit.Test

class NotificationRetentionTest {
    @Test fun limitsAreThreeToThirtyMinutesWithTenMinuteDefault() {
        assertEquals(600_000L, NotificationRetention.durationMillis(NotificationRetention.DEFAULT_MINUTES))
        assertEquals(180_000L, NotificationRetention.durationMillis(3))
        assertEquals(1_800_000L, NotificationRetention.durationMillis(30))
        for (invalid in listOf(Int.MIN_VALUE, 0, 2, 31, Int.MAX_VALUE)) {
            assertTrue(runCatching { NotificationRetention.durationMillis(invalid) }.isFailure)
        }
    }

    @Test fun changingLifetimeUsesOriginalReceiptTimeAndNeverRestartsAge() {
        val now = 2_000_000L; val received = now - 240_000L
        assertEquals(360_000L, NotificationRetention.remainingMillis(received, now, 10))
        assertEquals(0L, NotificationRetention.remainingMillis(received, now, 3))
        assertEquals(1_560_000L, NotificationRetention.remainingMillis(received, now, 30))
        assertEquals(0L, NotificationRetention.remainingMillis(now - 600_000L, now, 10))
        assertEquals(600_000L, NotificationRetention.remainingMillis(now + 60_000L, now, 10))
    }
}
