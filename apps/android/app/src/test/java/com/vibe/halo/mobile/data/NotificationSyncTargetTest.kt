package com.vibe.halo.mobile.data

import org.junit.Assert.*
import org.junit.Test

class NotificationSyncTargetTest {
    private val data = mapOf("protocolVersion" to "1", "pcId" to "pc_synthetic", "pcSessionEpoch" to "11111111-1111-4111-8111-111111111111",
        "eventId" to "event:synthetic", "eventRevision" to "1", "kind" to "completion")

    @Test fun routingIsBoundedAndNeverUsesPushContentOrUrls() {
        assertNotNull(NotificationSyncTarget.from(data + mapOf("preview" to "ciphertext", "relayOrigin" to "https://untrusted.invalid")))
        for (field in data.keys) assertNull(field, NotificationSyncTarget.from(data - field))
        for ((field, value) in listOf("protocolVersion" to "2", "pcId" to "../pcs", "eventId" to "../../query", "pcSessionEpoch" to "a".repeat(101),
            "eventRevision" to "0", "eventRevision" to "9007199254740992", "eventRevision" to "1.1", "kind" to "decision")) {
            assertNull("$field=$value", NotificationSyncTarget.from(data + (field to value)))
        }
    }
}
