package com.vibe.halo.mobile.data

import org.json.JSONArray
import org.json.JSONObject

object HistoryPresentation {
    private fun text(value: JSONObject, key: String, limit: Int = 600): String = value.optString(key).takeUnless { it == "null" }.orEmpty().take(limit)
    fun preview(value: JSONObject): String {
        val input = value.optJSONObject("toolInput") ?: runCatching { JSONObject(value.optString("toolInputText")) }.getOrNull()
        return listOf(text(value, "preview"), text(value, "summary"), value.optJSONArray("questions")?.optJSONObject(0)?.let { text(it, "question") }.orEmpty(),
            input?.let { listOf("command", "cmd", "path", "file_path", "query").map { key -> text(it, key) }.firstOrNull { v -> v.isNotBlank() } }.orEmpty(),
            text(value, "content"), text(value, "description"), text(value, "title"), text(value, "toolName")).firstOrNull { it.isNotBlank() }.orEmpty()
    }
    fun project(value: JSONObject) = text(value, "projectName", 120).ifBlank { text(value, "cwd").replace('\\', '/').trimEnd('/').substringAfterLast('/') }
    fun session(value: JSONObject) = text(value, "sessionLabel", 12).ifBlank { text(value, "sessionId", 12) }
    fun time(value: JSONObject): Long = value.optLong("finalizedAt").takeIf { it > 0 } ?: value.optLong("resolvedAt").takeIf { it > 0 } ?: value.optLong("createdAt")
    fun detail(response: JSONObject, fallback: JSONObject?): JSONObject {
        val source = if (response.optInt("viewVersion") == 2) response else runCatching { JSONObject(response.getString("text")) }.getOrNull()
        if (source == null) return JSONObject((fallback ?: JSONObject()).toString()).put("incomplete", true).put("excerpt", preview(fallback ?: JSONObject()))
        val view = JSONObject()
        for (key in listOf("id", "kind", "agentId", "agentName", "title", "toolName", "outcome", "outcomeLabel")) view.put(key, text(source, key))
        view.put("projectName", project(source)).put("sessionLabel", session(source)).put("preview", preview(source)).put("finalizedAt", time(source))
        val excerpt = text(source, "excerpt", 2400).ifBlank { preview(source) }
        view.put("excerpt", excerpt).put("truncated", response.optBoolean("truncated") || source.optBoolean("truncated"))
        view.put("answerAvailable", source.optBoolean("answerAvailable"))
        val questions = JSONArray(); val raw = source.optJSONArray("questions") ?: JSONArray()
        for (i in 0 until minOf(raw.length(), 10)) {
            val question = raw.optJSONObject(i) ?: continue
            val answer = if (source.optInt("viewVersion") == 2) text(question, "answer", 800) else {
                val value = source.optJSONObject("answers")?.opt(question.optString("id"))
                when (value) { is String -> value; is JSONArray -> (0 until minOf(value.length(), 20)).mapNotNull { value.opt(it) as? String }.joinToString(" · "); else -> "" }.take(800)
            }
            questions.put(JSONObject().put("question", text(question, "question", 800).ifBlank { text(question, "header") }).put("answer", answer))
        }
        return view.put("questions", questions)
    }
}
