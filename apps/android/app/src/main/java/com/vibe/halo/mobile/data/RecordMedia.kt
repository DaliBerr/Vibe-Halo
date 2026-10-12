package com.vibe.halo.mobile.data

import org.json.JSONObject

data class MediaSource(val computerKey: String, val kind: String, val id: String, val epoch: String = "") {
    fun fields() = JSONObject().put("source", kind).put("sourceId", id).put("pcSessionEpoch", epoch)
}
data class MediaVariant(val width: Int, val height: Int, val mime: String, val size: Int, val sha256: String)
data class RecordMedia(val id: String, val reference: String, val preview: MediaVariant, val full: MediaVariant) {
    companion object {
        fun parse(value: JSONObject): RecordMedia {
            fun variant(name: String): MediaVariant {
                val part = value.getJSONObject(name)
                return MediaVariant(part.getInt("width"), part.getInt("height"), part.getString("mime"), part.getInt("size"), part.getString("sha256")).also {
                    require(it.width in 1..2048 && it.height in 1..2048 && it.size in 1..(if (name == "preview") 49152 else 262144))
                    require(it.mime in listOf("image/png", "image/jpeg") && it.sha256.matches(Regex("[a-f0-9]{64}")))
                }
            }
            val id = value.getString("id"); val reference = value.getString("reference")
            require(id.matches(Regex("[a-f0-9-]{36}")) && reference.length in 1..2048)
            return RecordMedia(id, reference, variant("preview"), variant("full"))
        }
    }
}
