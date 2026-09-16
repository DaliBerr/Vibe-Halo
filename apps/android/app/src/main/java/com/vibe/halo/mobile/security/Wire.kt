package com.vibe.halo.mobile.security

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Interpreter for the checked-in, deliberately small JSON Schema subset. */
class Wire(context: Context) {
    private val schemas = listOf("event-summary", "event-detail", "decision-intent").associateWith { name ->
        JSONObject(context.assets.open("protocol/$name.json").bufferedReader().use { it.readText() })
    }
    fun validate(kind: String, value: JSONObject) {
        require(value.toString().toByteArray().size <= if (kind == "event-detail") 65536 else 16384) { "too_large" }
        require(value.optInt("protocolVersion") == 1) { "upgrade_required" }
        safe(value); checkSchema(schemas.getValue(kind), value)
        val source = if (kind == "event-detail") value.getJSONObject("summary") else value
        val begin = if (kind == "decision-intent") "issuedAt" else "createdAt"
        require(Instant.parse(source.getString("expiresAt")).isAfter(Instant.parse(source.getString(begin))))
        if (kind == "event-detail") Instant.parse(value.getString("pcTime"))
    }
    private fun checkSchema(schema: JSONObject, value: Any?) {
        if (schema.has("const")) require(equal(schema.get("const"), value))
        if (schema.has("enum")) require(schema.getJSONArray("enum").values().any { equal(it, value) })
        when (schema.optString("type")) {
            "object" -> {
                require(value is JSONObject)
                val keys = value.keys().asSequence().toSet()
                require(schema.optJSONArray("required")?.values()?.all { it in keys } != false)
                val properties = schema.optJSONObject("properties") ?: JSONObject()
                if (schema.opt("additionalProperties") == false) require(keys.all { properties.has(it) })
                for (key in keys) {
                    if (properties.has(key)) checkSchema(properties.getJSONObject(key), value.get(key))
                    else (schema.opt("additionalProperties") as? JSONObject)?.let { checkSchema(it, value.get(key)) }
                }
                schema.optInt("maxProperties", Int.MAX_VALUE).let { require(keys.size <= it) }
                schema.optJSONObject("propertyNames")?.let { property -> keys.forEach { checkSchema(property, it) } }
            }
            "array" -> {
                require(value is JSONArray)
                require(value.length() in schema.optInt("minItems", 0)..schema.optInt("maxItems", Int.MAX_VALUE))
                if (schema.optBoolean("uniqueItems")) require(value.values().map { DeviceCrypto.canonical(it) }.distinct().size == value.length())
                schema.optJSONObject("items")?.let { item -> value.values().forEach { checkSchema(item, it) } }
            }
            "string" -> {
                require(value is String)
                require(value.codePointCount(0, value.length) in schema.optInt("minLength", 0)..schema.optInt("maxLength", Int.MAX_VALUE))
                if (schema.has("pattern")) require(Regex(schema.getString("pattern")).containsMatchIn(value))
            }
            "boolean" -> require(value is Boolean)
            "integer", "number" -> {
                require(value is Number && value.toDouble().isFinite())
                if (schema.optString("type") == "integer") require(value.toDouble() == value.toLong().toDouble())
                require(value.toDouble() >= schema.optDouble("minimum", Double.NEGATIVE_INFINITY))
                require(value.toDouble() <= schema.optDouble("maximum", Double.POSITIVE_INFINITY))
            }
        }
        schema.optJSONArray("anyOf")?.let { branches -> require(branches.values().any { runCatching { checkSchema(it as JSONObject, value) }.isSuccess }) }
    }
    private fun equal(a: Any?, b: Any?) = if (a is Number && b is Number) a.toDouble() == b.toDouble() else a == b
    companion object {
        fun JSONArray.values(): List<Any> = (0 until length()).map { get(it) }
        fun safe(value: Any?) {
            var nodes = 0
            fun visit(item: Any?, depth: Int) {
                require(++nodes <= 4096 && depth <= 12)
                when (item) {
                    is JSONObject -> {
                        val keys = item.keys().asSequence().toList()
                        require(keys.size <= 500 && keys.none { it in setOf("__proto__", "constructor", "prototype") })
                        keys.forEach { visit(item.get(it), depth + 1) }
                    }
                    is JSONArray -> { require(item.length() <= 500); item.values().forEach { visit(it, depth + 1) } }
                    is String -> { require(item.length <= 262144); require(item.toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8) == item) }
                    is Number -> require(item.toDouble().isFinite())
                    is Boolean, null, JSONObject.NULL -> Unit
                    else -> error("invalid_structure")
                }
            }
            visit(value, 0)
        }
    }
}
