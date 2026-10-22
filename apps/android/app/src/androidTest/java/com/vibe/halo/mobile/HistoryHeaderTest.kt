package com.vibe.halo.mobile

import android.content.res.Configuration
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vibe.halo.mobile.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HistoryHeaderTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    private fun detail(kind: String = "completion", state: String = "resolved", title: String = "查找报告撰写模板") = JSONObject()
        .put("summary", JSONObject().put("kind", kind).put("agentId", "codex").put("state", state).put("createdAt", "2026-10-22T09:04:00Z"))
        .put("description", title).put("toolInputText", "建议补充 PCB 的设计取舍与检查依据。\n\n## 分析内容\n\n- 四层方案的取舍\n- 功率通路与回流路径")

    private fun show(detail: JSONObject, dark: Boolean = false, fontScale: Float = 1f) {
        val event = RemoteEvent("header", "pc", detail, 0)
        rule.activity.setContent {
            val config = Configuration(LocalConfiguration.current).apply {
                uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                    if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            }
            val density = LocalDensity.current
            CompositionLocalProvider(LocalConfiguration provides config, LocalDensity provides Density(density.density, fontScale)) {
                HaloTheme {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        HistoryDetailScreen(CompanionState(events = listOf(event)), "event:header") {}
                    }
                }
            }
        }
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            java.io.File(rule.activity.filesDir, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    private fun checkHeader() {
        rule.onAllNodesWithText("记录详情").assertCountEquals(0)
        rule.onAllNodesWithText("标题与类别").assertCountEquals(0)
        val title = rule.onNodeWithTag("history-title").assertIsDisplayed().getUnclippedBoundsInRoot()
        val badge = rule.onNodeWithTag("history-status").assertIsDisplayed().getUnclippedBoundsInRoot()
        val back = rule.onNodeWithText(if (UiLanguage.mode == "en-US") "← Back" else "← 返回").assertIsDisplayed().getUnclippedBoundsInRoot()
        assertTrue("Back stays above the title", back.bottom <= title.top)
        assertTrue("Status sits below the title", badge.top >= title.bottom)
        assertTrue("Status stays inside the title's left edge", badge.left >= title.left)
        assertTrue("Status stays inside the title's right edge", badge.right <= title.right)
    }

    @Test fun chatTitleAndCompactCompletionStatusLeadThePage() {
        UiLanguage.mode = "zh-CN"
        show(detail())
        checkHeader()
        rule.onNodeWithText("查找报告撰写模板").assertIsDisplayed()
        rule.onNodeWithText("已完成").assertIsDisplayed()
        rule.onAllNodesWithText("任务完成").assertCountEquals(0)
        capture("history-header-zh")
    }

    @Test fun darkLargeTextKeepsLongTitleAndEnglishStatusSeparate() {
        UiLanguage.mode = "en-US"
        try {
            show(detail("approval", "pending", "Review PCB design tradeoffs and verification").put("outcome", "disconnected"), dark = true, fontScale = 2f)
            checkHeader()
            rule.onNode(hasText("Link lost") and hasAnyAncestor(hasTestTag("history-status"))).assertIsDisplayed()
            capture("history-header-dark-large")
        } finally { UiLanguage.mode = "zh-CN" }
    }

    @Test fun badgesDistinguishPendingSuccessRejectionExpiryAndNativeHandling() {
        val cases = listOf(
            Triple("pending", "待处理", HistoryStatusTone.Warning),
            Triple("allow", "已允许", HistoryStatusTone.Success),
            Triple("deny", "已拒绝", HistoryStatusTone.Error),
            Triple("failed", "失败", HistoryStatusTone.Error),
            Triple("error", "失败", HistoryStatusTone.Error),
            Triple("timeout", "已超时", HistoryStatusTone.Warning),
            Triple("disconnected", "已断开", HistoryStatusTone.Error),
            Triple("native", "客户端处理", HistoryStatusTone.Neutral),
            Triple("closed", "已关闭", HistoryStatusTone.Neutral)
        )
        for ((outcome, label, tone) in cases) {
            val view = HistoryPresentation.model(detail("approval").put("outcome", outcome))
            assertEquals(HistoryStatus(label, tone), HistoryPresentation.status(view))
        }
        assertEquals(HistoryStatus("已就绪", HistoryStatusTone.Success), HistoryPresentation.status(HistoryPresentation.model(detail("plan"))))
    }

    @Test fun listCardsShowDistinctReadableStatusMarkers() {
        UiLanguage.mode = "zh-CN"
        val records = listOf(
            detail(title = "查找报告撰写模板"),
            detail(title = "生成报告预览").put("outcome", "failed"),
            detail("approval", "pending", "检查 PCB 接线"),
        ).map(HistoryPresentation::model)
        rule.activity.setContent {
            HaloTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp)) {
                        records.forEach { HistorySummaryCard(it.copy(excerpt = ""), "测试电脑") {} }
                    }
                }
            }
        }
        rule.onAllNodesWithTag("history-card-status", useUnmergedTree = true).assertCountEquals(3)
        rule.onNodeWithText("已完成").assertIsDisplayed()
        rule.onNodeWithText("失败").assertIsDisplayed()
        rule.onNodeWithText("待处理").assertIsDisplayed()
        capture("history-status-cards")
    }
}
