package com.vibe.halo.mobile.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

data class HistoryQuestion(val question: String, val options: List<String>, val answer: String)
data class HistoryView(val title: String, val kind: String, val client: String, val project: String, val session: String,
    val excerpt: String, val fields: List<Pair<String, String>>, val questions: List<HistoryQuestion>, val result: String,
    val time: Long, val shortened: Boolean, val unavailable: Boolean)

object HistoryPresentation {
    private fun raw(value: JSONObject, key: String): String = (value.opt(key) as? String).orEmpty().trim()
    private fun plain(value: String): String = value.takeUnless { it.startsWith("{") || it.startsWith("[") }.orEmpty()
    private fun text(value: JSONObject, key: String, limit: Int = 600) = plain(raw(value, key)).take(limit)
    fun project(value: JSONObject) = text(value, "projectName", 120).ifBlank { text(value, "cwd").replace('\\', '/').trimEnd('/').substringAfterLast('/') }
    fun session(value: JSONObject) = text(value, "sessionLabel", 12).ifBlank { text(value, "sessionId", 12) }
    fun time(value: JSONObject): Long {
        val source = value.optJSONObject("summary") ?: value
        for (key in listOf("finalizedAt", "resolvedAt", "createdAt")) {
            val v = source.opt(key)
            val stamp = (v as? Number)?.toLong() ?: (v as? String)?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0
            if (stamp > 0) return stamp
        }
        return 0
    }
    fun model(value: JSONObject): HistoryView {
        val meta = value.optJSONObject("summary") ?: value
        val kind = text(meta, "kind")
        val inputText = raw(value, "toolInputText")
        val structured = inputText.startsWith("{") || inputText.startsWith("[")
        val parsed = if (structured) runCatching { org.json.JSONTokener(inputText).nextValue() }.getOrNull() else null
        val input = value.optJSONObject("toolInput") ?: parsed as? JSONObject
        val fields = listOf("command" to "命令", "cmd" to "命令", "file_path" to "文件", "path" to "文件", "query" to "查询", "description" to "用途")
            .mapNotNull { (key, label) -> input?.let { text(it, key, 800) }?.takeIf { it.isNotBlank() }?.let { label to it } }.distinctBy { it.first }
        val sourceQuestions = value.optJSONArray("questions")?.takeIf { it.length() > 0 } ?: input?.optJSONArray("questions") ?: parsed as? JSONArray ?: JSONArray()
        val questions = (0 until minOf(sourceQuestions.length(), 10)).mapNotNull { i ->
            val q = sourceQuestions.optJSONObject(i) ?: return@mapNotNull null
            val question = text(q, "question", 800).ifBlank { text(q, "header", 800) }
            if (question.isBlank()) return@mapNotNull null
            val answer = q.opt("answer") ?: value.optJSONObject("answers")?.opt(raw(q, "id"))
            val answerText = when (answer) { is String -> plain(answer); is JSONArray -> (0 until minOf(answer.length(), 20)).mapNotNull { answer.opt(it) as? String }.map(::plain).filter { it.isNotBlank() }.joinToString(" · "); else -> "" }
            val options = q.optJSONArray("options") ?: JSONArray()
            HistoryQuestion(question, (0 until minOf(options.length(), 20)).mapNotNull { n -> when(val option = options.opt(n)) { is String -> plain(option); is JSONObject -> text(option, "label"); else -> null } }.filter { it.isNotBlank() }, answerText.take(800))
        }
        val body = listOf(raw(value, "excerpt"), raw(value, "content"), if (!structured) inputText else "", raw(value, "preview"), raw(value, "summary")).map(::plain).firstOrNull { it.isNotBlank() }.orEmpty()
        val title = questions.firstOrNull()?.question?.take(160).orEmpty().ifBlank { text(value, "title", 160) }.ifBlank { text(value, "description", 160) }.ifBlank { text(value, "toolName", 160) }
        val excerpt = body.ifBlank { if (questions.isEmpty() && fields.isEmpty()) text(value, "description", 2400) else "" }
        val result = when (raw(value, "outcome").ifBlank { raw(meta, "state") }) {
            "allow", "once", "always" -> "已允许"; "deny", "reject" -> "已拒绝"; "submit", "answered" -> "已回答"
            "timeout", "expired" -> "已超时"; "disconnected" -> "连接已断开"; "dismissed", "closed" -> "已关闭"
            "native", "fallback" -> "已交回客户端"; "pending" -> "待处理"
            else -> when(kind) { "completion" -> "任务已完成"; "plan" -> "计划已准备好"; else -> "已结束" }
        }
        val tooLong = body.length > 2400 || sourceQuestions.length() > 10 || (0 until sourceQuestions.length()).any { sourceQuestions.optJSONObject(it)?.let { q -> raw(q, "question").length > 800 || raw(q, "answer").length > 800 } == true }
        return HistoryView(title, kind, text(value, "agentName").ifBlank { text(meta, "agentId") }, project(value), session(value), excerpt.take(2400), fields, questions, result, time(value),
            value.optBoolean("truncated") || tooLong, value.optBoolean("incomplete") || (structured && fields.isEmpty() && questions.isEmpty() && body.isBlank()))
    }
    fun preview(value: JSONObject): String = model(value).let { view ->
        (view.questions.firstOrNull()?.question ?: view.fields.firstOrNull()?.second ?: view.excerpt.ifBlank { view.title }).take(600)
    }
    fun detail(response: JSONObject, fallback: JSONObject?): JSONObject {
        val source = if (response.optInt("viewVersion") == 2) response else runCatching { JSONObject(raw(response, "text")) }.getOrNull()
        if (source == null) return JSONObject((fallback ?: JSONObject()).toString()).put("incomplete", true).put("excerpt", preview(fallback ?: JSONObject()))
        val view = model(source)
        val questions = JSONArray()
        view.questions.forEach { q -> questions.put(JSONObject().put("question", q.question).put("answer", q.answer).put("options", JSONArray(q.options))) }
        // Keep the wire response internal. Renderers consume only HistoryView.
        return JSONObject(source.toString()).put("questions", questions).put("projectName", view.project).put("sessionLabel", view.session)
            .put("finalizedAt", view.time).put("truncated", response.optBoolean("truncated") || view.shortened)
    }
}
