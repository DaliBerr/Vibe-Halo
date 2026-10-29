package com.vibe.halo.mobile.notifications

import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

object NotificationTiming {
    fun record(stage: String, data: Map<String, String>, transport: String, started: Long? = null) {
        runCatching {
            val id = data["eventId"] ?: return
            if (!Regex("[A-Za-z0-9_.:-]{1,240}").matches(id)) return
            val value = JSONObject().put("code", "notification_timing").put("host", "android")
                .put("stage", stage).put("eventId", id).put("revision", data["eventRevision"]?.toLongOrNull() ?: 0)
                .put("transport", transport).put("atMs", System.currentTimeMillis())
            if (started != null) value.put("elapsedMs", (SystemClock.elapsedRealtime() - started).coerceAtLeast(0))
            Log.i("VibeHaloTiming", value.toString())
        }
    }
}
