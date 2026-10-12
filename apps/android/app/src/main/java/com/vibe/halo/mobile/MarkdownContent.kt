package com.vibe.halo.mobile

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.*
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibe.halo.mobile.data.*
import org.commonmark.node.*
import org.commonmark.node.Text as MarkdownText
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.tables.*

@Composable fun MarkdownContent(text: String, isCodex: Boolean, modifier: Modifier = Modifier) {
    val document = remember(text, isCodex) { RichContent.parse(text, isCodex) }
    SelectionContainer { Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        RichContent.children(document).forEach { MarkdownBlock(it, 0) }
    } }
}

@Composable private fun MarkdownBlock(node: Node, depth: Int) {
    if (depth > 16) { Text(RichContent.plain(node), fontSize = 15.sp); return }
    when (node) {
        is Heading -> Text(inlines(node), fontSize = (24 - node.level.coerceIn(1, 6)).sp, fontWeight = FontWeight.SemiBold)
        is org.commonmark.node.Paragraph -> Text(inlines(node), fontSize = 15.sp, lineHeight = 23.sp)
        is FencedCodeBlock -> CodeBlock(node.literal, node.info.substringBefore(' '))
        is IndentedCodeBlock -> CodeBlock(node.literal, "")
        is BlockQuote -> Row(Modifier.fillMaxWidth()) {
            Column(Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { RichContent.children(node).forEach { MarkdownBlock(it, depth + 1) } }
        }
        is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            RichContent.children(node).forEachIndexed { index, item -> Row(Modifier.fillMaxWidth()) {
                Text(if (node is OrderedList) "${node.markerStartNumber + index}." else "•", Modifier.padding(end = 8.dp), fontSize = 15.sp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { RichContent.children(item).forEach { MarkdownBlock(it, depth + 1) } }
            } }
        }
        is ThematicBreak -> HorizontalDivider()
        is TableBlock -> Column(Modifier.horizontalScroll(rememberScrollState()).border(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            RichContent.children(node).flatMap { RichContent.children(it) }.forEach { row -> Row {
                RichContent.children(row).forEach { cell -> Text(inlines(cell), Modifier.width(180.dp).border(0.5.dp, MaterialTheme.colorScheme.outlineVariant).padding(8.dp), fontSize = 14.sp, fontWeight = if ((cell as? TableCell)?.isHeader == true) FontWeight.Bold else FontWeight.Normal) }
            } }
        }
        is CodexCard -> CodexDirectiveCard(node)
        else -> Text(RichContent.plain(node), fontSize = 15.sp)
    }
}

@Composable private fun CodeBlock(code: String, language: String) {
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(8.dp)) {
        Column(Modifier.padding(10.dp)) {
            if (language.isNotBlank()) Text(language, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(code.trimEnd('\n'), Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 20.sp)
        }
    }
}

@Composable private fun inlines(node: Node): AnnotatedString {
    val colors = MaterialTheme.colorScheme; val handler = LocalUriHandler.current
    return buildAnnotatedString {
        fun appendNode(current: Node, depth: Int) {
            if (depth > 24) return
            fun nested() { RichContent.children(current).forEach { appendNode(it, depth + 1) } }
            when (current) {
                is MarkdownText -> append(current.literal)
                is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = colors.surfaceContainerHighest)) { append(current.literal) }
                is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { nested() }
                is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { nested() }
                is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { nested() }
                is HardLineBreak, is SoftLineBreak -> append('\n')
                is HtmlInline -> append(current.literal)
                is Image -> { append(tr("图片") + ": "); append(RichContent.plain(current).ifBlank { tr("查看图片") }) }
                is Link -> {
                    val url = RichContent.webLink(current.destination)
                    if (url == null) nested() else withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline)), LinkInteractionListener { runCatching { handler.openUri(url) } })) { nested() }
                }
                else -> nested()
            }
        }
        RichContent.children(node).forEach { appendNode(it, 0) }
    }
}

@Composable private fun CodexDirectiveCard(card: CodexCard) {
    val label = when(card.kind) {
        "inbox-item" -> "任务摘要"; "code-comment" -> "代码批注"; "archive-thread" -> "归档标记"
        "created-thread" -> "关联会话"; "codex-followup" -> "后续建议"; else -> "自动化记录"
    }
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(10.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Codex · " + tr(label), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSecondaryContainer)
            card.fields["title"]?.let { Text(it, fontWeight = FontWeight.SemiBold, fontSize = 16.sp) }
            for (key in listOf("summary", "body", "label")) card.fields[key]?.let { Text(it, fontSize = 14.sp) }
            card.fields["file"]?.let { Text(it.replace('\\', '/').substringAfterLast('/') + (card.fields["start"]?.let { line -> ":$line" } ?: ""), fontFamily = FontFamily.Monospace, fontSize = 12.sp) }
            Text(tr("仅展示记录，请在 Codex 中操作。"), fontSize = 11.sp)
        }
    }
}
