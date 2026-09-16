package com.vibe.halo.mobile.data

import org.junit.Assert.*
import org.junit.Test

class PcClockTest {
    @Test fun oldEventDoesNotRestartDeadlineOnFirstOpen() {
        val eventCreated = 1_000_000L
        val clock = PcClock.sample("epoch", eventCreated + 45000, 100, 200)
        assertEquals(74900L, eventCreated + 120000 - clock.now("epoch", 200)!!)
        assertEquals(69900L, eventCreated + 120000 - clock.now("epoch", 5200)!!)
    }
    @Test fun newClockSampleCannotExtendAnExistingDeadline() {
        val first = PcClock.sample("epoch", 1_000_000, 0, 100)
        val next = PcClock.sample("epoch", 999000, 5100, 5200, first)
        assertEquals(first.now("epoch", 5200), next.now("epoch", 5200))
    }
    @Test fun staleSampleAndPreviousPcEpochAreReadOnly() {
        val clock = PcClock.sample("epoch", 1_000_000, 100, 200)
        assertNull(clock.now("new-epoch", 300))
        assertNull(clock.now("epoch", 60201))
        assertNull(clock.now("epoch", 199))
    }
    @Test fun excessiveRoundTripCannotCalibrate() {
        assertThrows(IllegalArgumentException::class.java) { PcClock.sample("epoch", 1_000_000, 100, 5101) }
    }
}
