package com.vibe.halo.mobile.data

/** A fresh signed challenge response, never the timestamp of a cached event. */
data class PcClock(val epoch: String, val pcAtReceipt: Long, val receivedElapsed: Long) {
    fun now(expectedEpoch: String, elapsed: Long): Long? {
        val age = elapsed - receivedElapsed
        return if (expectedEpoch == epoch && age in 0..60000) pcAtReceipt + age else null
    }
    companion object {
        fun sample(epoch: String, pcMillis: Long, startedElapsed: Long, receivedElapsed: Long, previous: PcClock? = null): PcClock {
            val roundTrip = receivedElapsed - startedElapsed
            require(epoch.isNotBlank() && pcMillis > 0 && roundTrip in 0..5000) { "clock_refresh_required" }
            // Advance by the whole round trip, conservatively expiring a little
            // early rather than extending a deadline through network latency.
            var estimate = pcMillis + roundTrip
            if (previous?.epoch == epoch && receivedElapsed >= previous.receivedElapsed) {
                estimate = maxOf(estimate, previous.pcAtReceipt + receivedElapsed - previous.receivedElapsed)
            }
            return PcClock(epoch, estimate, receivedElapsed)
        }
    }
}
