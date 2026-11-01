package com.vibe.halo.mobile.data

/** Routing hints only. Full details must still pass binding and signature checks. */
data class NotificationSyncTarget(val pcId: String, val epoch: String, val eventId: String, val revision: Long, val kind: String) {
    companion object {
        fun from(data: Map<String, String>): NotificationSyncTarget? {
            if (data["protocolVersion"] != "1") return null
            val pcId = data["pcId"]?.takeIf { Regex("pc_[A-Za-z0-9-]{1,80}").matches(it) } ?: return null
            val epoch = data["pcSessionEpoch"]?.takeIf { Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(it) } ?: return null
            val eventId = data["eventId"]?.takeIf { Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}").matches(it) } ?: return null
            val revision = data["eventRevision"]?.toLongOrNull()?.takeIf { it in 1..9007199254740991L } ?: return null
            val kind = data["kind"]?.takeIf { it in setOf("approval", "question", "input", "plan", "completion") } ?: return null
            return NotificationSyncTarget(pcId, epoch, eventId, revision, kind)
        }
    }
}

enum class NotificationSyncResult { SYNCED, RETRY, IGNORED }
