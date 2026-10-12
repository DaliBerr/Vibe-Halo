package com.vibe.halo.mobile.data

import org.commonmark.node.*
import org.commonmark.parser.Parser
import org.commonmark.parser.block.*
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import java.net.URI

class CodexCard(val kind: String, val fields: Map<String, String>) : CustomBlock()

object RichContent {
    private val extensions = listOf(TablesExtension.create(), StrikethroughExtension.create())
    private val markdown = Parser.builder().extensions(extensions).build()
    private val codex = Parser.builder().extensions(extensions).customBlockParserFactory(object : AbstractBlockParserFactory() {
        override fun tryStart(state: ParserState, matchedBlockParser: MatchedBlockParser): BlockStart? {
            if (state.indent >= 4) return BlockStart.none()
            val line = state.line.content.toString()
            val card = directive(line.substring(state.nextNonSpaceIndex).trim()) ?: return BlockStart.none()
            return BlockStart.of(object : AbstractBlockParser() {
                override fun getBlock(): Block = card
                override fun tryContinue(state: ParserState): BlockContinue? = BlockContinue.none()
            }).atIndex(line.length)
        }
    }).build()
    fun parse(text: String, isCodex: Boolean = false): Node = runCatching {
        (if (isCodex) codex else markdown).parse(text.take(48000))
    }.getOrElse { Document().apply { appendChild(Paragraph().apply { appendChild(Text(text.take(48000))) }) } }

    fun children(node: Node): List<Node> = generateSequence(node.firstChild) { it.next }.toList()
    fun plain(node: Node, depth: Int = 0): String {
        if (depth > 24) return ""
        return when (node) {
            is Text -> node.literal; is Code -> node.literal
            is FencedCodeBlock -> node.literal; is IndentedCodeBlock -> node.literal
            is SoftLineBreak, is HardLineBreak -> "\n"
            is HtmlInline -> node.literal; is HtmlBlock -> node.literal
            is CodexCard -> listOfNotNull(node.fields["title"], node.fields["summary"], node.fields["body"], node.fields["label"]).joinToString(" · ")
            else -> children(node).joinToString(if (node is Document || node is ListBlock) "\n" else "") { plain(it, depth + 1) }
        }
    }
    fun webLink(destination: String): String? = runCatching {
        val uri = URI(destination)
        destination.takeIf { uri.scheme?.lowercase() in listOf("https", "http") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && destination.length <= 2048 }
    }.getOrNull()
    fun imageReferences(node: Node): List<String> {
        val refs = linkedSetOf<String>()
        fun walk(current: Node, depth: Int) {
            if (depth > 24) return
            val ref = when (current) { is Image -> current.destination; is Link -> current.destination; else -> "" }
            if (Regex("(?i)\\.(png|jpe?g|webp|gif)$").containsMatchIn(ref)) refs.add(ref)
            children(current).forEach { walk(it, depth + 1) }
        }
        walk(node, 0); return refs.take(4)
    }
    // Parse only standalone known directives. Code spans/fences and malformed text stay literal.
    fun directive(line: String): CodexCard? {
        val match = Regex("^::(inbox-item|code-comment|archive-thread|created-thread|automation-update)\\{(.*)\\}$").matchEntire(line)
        val followup = Regex("^:codex-followup\\[([^\\n]+?)\\]\\{(.*)\\}$").matchEntire(line)
        val kind = match?.groupValues?.get(1) ?: if (followup != null) "codex-followup" else return null
        val source = match?.groupValues?.get(2) ?: followup!!.groupValues[2]
        val fields = linkedMapOf<String, String>(); var offset = 0
        val attr = Regex("([A-Za-z][A-Za-z0-9_-]*)\\s*=\\s*(?:\"((?:\\\\.|[^\"\\\\])*)\"|([0-9]+|true|false))")
        while (offset < source.length) {
            while (offset < source.length && source[offset].isWhitespace()) offset++
            if (offset == source.length) break
            val item = attr.find(source, offset)?.takeIf { it.range.first == offset } ?: return null
            if (fields.containsKey(item.groupValues[1]) || fields.size >= 16) return null
            val value = if (item.groups[2] != null) item.groupValues[2].replace(Regex("\\\\([\\\\\"])"), "$1") else item.groupValues[3]
            fields[item.groupValues[1]] = value
            offset = item.range.last + 1
            if (offset < source.length && !source[offset].isWhitespace()) return null
        }
        if (followup != null) fields["label"] = followup.groupValues[1]
        if (kind == "inbox-item" && fields["title"].isNullOrBlank() || kind == "code-comment" && fields["body"].isNullOrBlank()) return null
        return CodexCard(kind, fields)
    }
}
