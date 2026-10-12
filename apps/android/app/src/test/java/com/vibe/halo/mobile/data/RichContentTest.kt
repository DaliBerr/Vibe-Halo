package com.vibe.halo.mobile.data

import org.commonmark.node.*
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.junit.Assert.*
import org.junit.Test

class RichContentTest {
    private fun descendants(node: Node): List<Node> = listOf(node) + RichContent.children(node).flatMap(::descendants)
    @Test fun parsesCodeListsHeadingsQuotesTablesAndNestedEmphasis() {
        val text = "# 结果\n\n**加粗 *斜体*** 和 `recover-pending`，~~删除~~\n\n- 列表\n\n> 引用\n\n```kotlin\nval x = 1\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| 渲染 | 完成 |"
        val nodes = descendants(RichContent.parse(text))
        for (type in listOf(Heading::class.java, Code::class.java, StrongEmphasis::class.java, Emphasis::class.java, BulletList::class.java, BlockQuote::class.java, FencedCodeBlock::class.java, TableBlock::class.java, Strikethrough::class.java)) assertTrue(type.simpleName, nodes.any { type.isInstance(it) })
        assertTrue(RichContent.plain(RichContent.parse(text)).contains("recover-pending"))
    }
    @Test fun codexCardsKeepQuotedBracesEscapesAndWindowsPathsAndNeverExecuteActions() {
        val card = RichContent.directive("::inbox-item{title=\"完成 {UI}\" summary=\"已处理 \\\"背包\\\"\"}")!!
        assertEquals("完成 {UI}", card.fields["title"]); assertEquals("已处理 \"背包\"", card.fields["summary"])
        val comment = RichContent.directive("::code-comment{title=\"检查\" body=\"问题说明\" file=\"C:\\Tools\\main.js\" start=12 priority=2}")!!
        assertEquals("C:\\Tools\\main.js", comment.fields["file"]); assertEquals("12", comment.fields["start"])
        assertEquals("archive-thread", RichContent.directive("::archive-thread{}")!!.kind)
        val followup = descendants(RichContent.parse("- :codex-followup[继续检查]{prompt=\"检查这段代码\"}", true)).filterIsInstance<CodexCard>().single()
        assertEquals("继续检查", followup.fields["label"])
    }
    @Test fun directivesOnlyApplyToStandaloneCodexProseAndNotExamplesOrBrokenInput() {
        val directive = "::inbox-item{title=\"测试\" summary=\"完成\"}"
        val source = "$directive\n正文\n\n`$directive`\n\n```text\n$directive\n```\n\n    $directive"
        assertEquals(1, descendants(RichContent.parse(source, true)).filterIsInstance<CodexCard>().size)
        assertTrue(descendants(RichContent.parse(source, false)).none { it is CodexCard })
        for (bad in listOf("::inbox-item{title=\"未完成", "::unknown{title=\"保留\"}", "::inbox-item{title=\"a\" title=\"b\"}", "::code-comment{title=\"缺少正文\"}")) assertNull(RichContent.directive(bad))
    }
    @Test fun imageLinksSupportSpacesAndReferencesAndCodeExamplesDoNotBecomeImages() {
        val tree = RichContent.parse("[查看预览](<C:/Unity Project/a.png>)\n\n![图][ref]\n\n[ref]: ./b.jpg\n\n`![secret](ignore.png)`\n\n```\n![x](also-ignore.png)\n```")
        assertEquals(listOf("C:/Unity Project/a.png", "./b.jpg"), RichContent.imageReferences(tree))
        assertFalse(RichContent.plain(tree).contains("C:/Unity"))
    }
    @Test fun onlyExplicitWebUrlsCanOpenAndRawHtmlStaysLiteral() {
        assertEquals("https://example.com/x", RichContent.webLink("https://example.com/x"))
        for (bad in listOf("javascript:alert(1)", "file:///C:/secret", "content://app/private", "intent://scan", "codex://threads/1", "//evil.test", "https://user:pass@example.com", "https://example.com\n")) assertNull(bad, RichContent.webLink(bad))
        assertTrue(RichContent.plain(RichContent.parse("<script>alert(1)</script>")).contains("<script>"))
    }
}
