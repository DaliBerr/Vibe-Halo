package com.vibe.halo.mobile

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RichHistoryTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()
    private fun capture(name: String) {
        rule.waitForIdle()
        // Compose idleness precedes Android window/surface animations (notably Dialog dismissal).
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(500)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        java.io.File(rule.activity.filesDir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    @Test fun newCompletionShowsMarkdownAndCodexCardWithNoRawDirectives() {
        UiLanguage.mode = "zh-CN"
        val content = "## 背包界面已完成\n\n老大，**21 张素材**已导入，状态为 `ready`。\n\n- 字槽与字圈已接入\n- 支持 *书页切换*\n\n[查看预览](<C:/Unity Project/Lilith/preview.png>)\n\n::inbox-item{title=\"背包验收\" summary=\"13 项检查通过，等待游戏内验收。\"}"
        val detail = JSONObject().put("summary", JSONObject().put("eventId", "fixture").put("agentId", "codex").put("kind", "completion").put("state", "resolved"))
            .put("description", "Lilith").put("toolInputText", content)
        val event = RemoteEvent("fixture", "pc", detail, 0)
        rule.activity.setContent { HaloTheme { HistoryDetailScreen(CompanionState(events = listOf(event)), "event:fixture") {} } }
        rule.onNodeWithText("背包界面已完成").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("老大，21 张素材已导入，状态为 ready。").assertIsDisplayed()
        rule.onNodeWithText("背包验收").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("13 项检查通过，等待游戏内验收。").performScrollTo().assertIsDisplayed()
        rule.onAllNodesWithText("::inbox-item", substring = true).assertCountEquals(0)
        rule.onAllNodesWithText("C:/Unity", substring = true).assertCountEquals(0)
        capture("rich-history-zh")
        val linkFirst = HistoryPresentation.model(JSONObject().put("kind", "completion").put("toolInputText", "[预览](<C:/Unity Project/test.png>)"))
        assertTrue(linkFirst.excerpt.startsWith("[预览]"))
    }
    @Test fun imageThumbnailOpensFullImageZoomsAndClosesWithoutLosingText() {
        UiLanguage.mode = "zh-CN"
        val bitmap = Bitmap.createBitmap(800, 480, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap); canvas.drawColor(Color.rgb(224, 239, 228))
        val paint = Paint().apply { color = Color.rgb(35, 96, 65); textSize = 54f; isAntiAlias = true }
        canvas.drawText("Vibe Halo", 55f, 115f, paint)
        for (i in 0..2) { paint.color = listOf(0xFF80AB8B.toInt(), 0xFFEBD8AA.toInt(), 0xFF9BACC5.toInt())[i]; canvas.drawRoundRect(55f + i * 245, 180f, 265f + i * 245, 400f, 18f, 18f, paint) }
        val image = bitmap.asImageBitmap()
        val variant = MediaVariant(800, 480, "image/png", 100, "a".repeat(64))
        val item = RecordMedia("00000000-0000-0000-0000-000000000001", "C:/Unity%20Project/preview.png", variant, variant)
        var previewLoads = 0; var fullLoads = 0
        rule.activity.setContent { HaloTheme { Surface { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
            MarkdownContent("## 任务完成\n\n已完成 **图片同步**，点击下方预览查看细节。", true)
            RecordImageGallery(listOf("C:/Unity Project/preview.png"), { listOf(item) }, { _, full -> if (full) fullLoads++ else previewLoads++; image })
        } } } }
        rule.waitUntil(5000) { previewLoads == 1 }
        rule.onNodeWithContentDescription("点击查看大图").assertIsDisplayed().performClick()
        rule.waitUntil(5000) { fullLoads == 1 }
        rule.onNodeWithContentDescription("图片大图").assertIsDisplayed()
        rule.onNodeWithText("+").performClick()
        rule.onNodeWithContentDescription("图片大图").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "150%"))
        capture("rich-image-zoom")
        rule.onNodeWithText("重置").performClick()
        rule.onNodeWithContentDescription("图片大图").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "100%"))
        rule.onNodeWithText("关闭").performClick()
        rule.onNodeWithText("任务完成").assertIsDisplayed(); capture("rich-image-preview")
        assertEquals(1, previewLoads); assertEquals(1, fullLoads)
    }
    @Test fun darkLargeTextAndUnavailableImagesKeepBodyReadable() {
        UiLanguage.mode = "en-US"
        rule.activity.setContent { CompositionLocalProvider(LocalDensity provides Density(1f, 1.6f)) {
            MaterialTheme(colorScheme = darkColorScheme()) { Surface { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
                MarkdownContent("# Results\n\n**Complete** with `ready`.\n\n| Item | Result |\n| --- | --- |\n| Markdown | Pass |\n\n::code-comment{title=\"Review\" body=\"Check the spacing.\" file=\"main.js\" start=12}", true)
                RecordImageGallery(listOf("missing.png"), { throw IllegalStateException("offline") }, { _, _ -> error("not reached") })
            } } }
        } }
        rule.onNodeWithText("Results").assertIsDisplayed()
        rule.onNodeWithText("Check the spacing.").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Image unavailable. Check that the computer is online and the image has synced.").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Retry").assertIsDisplayed(); capture("rich-history-dark-large")
        UiLanguage.mode = "zh-CN"
    }
}
