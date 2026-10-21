package com.vibe.halo.mobile.notifications

import android.content.Context
import com.vibe.halo.mobile.security.DeviceCrypto
import com.vibe.halo.mobile.security.SecureStore
import com.vibe.halo.mobile.security.Wire.Companion.values
import org.json.JSONObject
import java.time.Instant

data class NotificationPreview(val agent: String, val context: String = "", val text: String = "") {
    companion object {
        fun snippet(value: String, limit: Int): String {
            val clean = value.replace(Regex("""\bBearer\s+[A-Za-z0-9._~+/\-]+""", RegexOption.IGNORE_CASE), "Bearer [REDACTED]")
                .replace(Regex("""\b((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)""", RegexOption.IGNORE_CASE), "$1[REDACTED]")
                .replace(Regex("""\bsk-[A-Za-z0-9_-]{10,}"""), "[REDACTED]")
                .replace(Regex("!\\[[^\\]]*\\]\\([^\\n]*?\\)"), "")
                .replace(Regex("\\[([^\\]]+)\\]\\([^\\n]*?\\)"), "$1")
                .replace(Regex("(?m)^[ \\t]*[:#>*-]+[ \\t]*"), "")
                .replace(Regex("[`*_\\x00-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]"), " ")
                .replace(Regex("\\s+"), " ").trim()
            val points = clean.codePoints().toArray()
            return if (points.size > limit) String(points, 0, limit - 1) + "…" else clean
        }
        fun agentName(id: String): String = when (id) {
            "codex" -> "Codex"; "claude-code" -> "Claude Code"; "zcode" -> "ZCode"
            "opencode" -> "OpenCode"; "gemini-cli" -> "Gemini CLI"; "copilot-cli" -> "Copilot CLI"
            else -> snippet(id, 40)
        }
        fun fromDetail(detail: JSONObject): NotificationPreview {
            val summary = detail.getJSONObject("summary"); val kind = summary.getString("kind")
            var text = detail.optString("toolInputText")
            val description = detail.optString("description")
            if (kind == "approval") {
                val input = runCatching { JSONObject(text) }.getOrNull()
                text = listOf("description", "command", "file_path", "path").firstNotNullOfOrNull { key -> input?.optString(key)?.takeIf { it.isNotEmpty() } } ?: ""
                text = listOf(detail.optString("toolName"), description.ifBlank { text }).filter { it.isNotBlank() }.joinToString(" · ")
            } else if (kind in listOf("question", "input")) {
                text = detail.optJSONArray("questions")?.optJSONObject(0)?.optString("question")?.takeIf { it.isNotBlank() } ?: description.ifBlank { text }
            }
            return NotificationPreview(agentName(summary.getString("agentId")), if (kind in listOf("completion", "plan")) snippet(description, 60) else "", snippet(text, 160))
        }

        // Runs on Firebase's worker thread using only local keys. Never wait for
        // a network request while Android grants a short push processing window.
        fun decrypt(context: Context, data: Map<String, String>): NotificationPreview? {
            val envelope = data["preview"] ?: return null
            require(envelope.length <= 3000)
            val origins = SecureStore(context).read().optJSONArray("origins")?.values().orEmpty()
            for (rawOrigin in origins) {
                val origin = rawOrigin as String; val store = SecureStore(context, origin)
                val saved = store.read()
                for (raw in saved.optJSONArray("bindings")?.values().orEmpty()) {
                    val binding = raw as JSONObject; val grant = binding.getJSONObject("grant")
                    if (binding.getString("state") != "active" || grant.getJSONObject("pc").getString("deviceId") != data["pcId"]) continue
                    // A PC identity can be paired on more than one relay origin.
                    // Try each local binding without letting an old origin mask it.
                    val candidate = runCatching {
                        val crypto = DeviceCrypto(context, store)
                        val signedGrant = DeviceCrypto.verify(binding.getString("grantJws"), grant.getJSONObject("pc").getJSONObject("signKey"), "binding-grant")
                        require(DeviceCrypto.canonical(signedGrant) == DeviceCrypto.canonical(grant))
                        require(grant.getString("relayOrigin") == origin && grant.getJSONArray("scopes").values().contains("events.read"))
                        require(DeviceCrypto.canonical(grant.getJSONObject("mobile")) == DeviceCrypto.canonical(crypto.publicDevice))
                        val value = crypto.open(envelope, grant.getJSONObject("pc").getJSONObject("signKey"), "notification-preview")
                        verified(value, data, origin, grant, crypto.publicDevice.getString("deviceId"))
                    }.getOrNull()
                    if (candidate != null) return candidate
                }
            }
            error("unknown_notification_sender")
        }
        internal fun verified(value: JSONObject, data: Map<String, String>, origin: String, grant: JSONObject, mobileId: String): NotificationPreview {
            require(value.getInt("protocolVersion") == 1 && value.getString("relayOrigin") == origin)
            require(value.getString("mobileId") == mobileId && value.getString("bindingId") == grant.getString("bindingId") && value.getInt("bindingRevision") == grant.getInt("revision"))
            for (key in listOf("pcId", "eventId", "eventRevision", "pcSessionEpoch", "kind", "expiresAt")) require(value.get(key).toString() == data[key])
            require(Instant.parse(value.getString("expiresAt")).toEpochMilli() > System.currentTimeMillis())
            val preview = value.getJSONObject("preview")
            return NotificationPreview(snippet(preview.getString("agent"), 40), snippet(preview.getString("context"), 60), snippet(preview.getString("text"), 160))
        }
    }
}
