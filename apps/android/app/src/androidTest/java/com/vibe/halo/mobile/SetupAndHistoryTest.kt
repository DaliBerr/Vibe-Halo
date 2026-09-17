package com.vibe.halo.mobile

import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vibe.halo.mobile.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SetupAndHistoryTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()
    @Test fun setupRequiresPairingAndDoesNotTreatSkippedPermissionsAsCompleted() {
        UiLanguage.mode = "zh-CN"
        var paired by mutableStateOf(false); var finished = false
        rule.activity.setContent { HaloTheme { SetupScreen(true, paired, {}) { finished = true } } }
        rule.onNodeWithText("进入应用").performScrollTo().assertIsNotEnabled()
        assertFalse(finished)
        rule.runOnUiThread { paired = true }
        rule.onNodeWithText("进入应用").performScrollTo().assertIsEnabled().performClick()
        assertTrue(finished)
    }
    @Test fun historyConvertsLegacyRecordsAndNeverDisplaysBrokenJson() {
        val raw = JSONObject().put("kind", "question").put("questions", org.json.JSONArray("[{\"id\":\"q\",\"question\":\"选择方案\"}]"))
            .put("answers", JSONObject().put("q", "方案二")).put("answerAvailable", true).put("cwd", "C:\\Tools\\Halo").put("sessionId", "session-123456789").put("finalizedAt", 42)
        val detail = HistoryPresentation.detail(JSONObject().put("text", raw.toString()), null)
        assertEquals("方案二", detail.getJSONArray("questions").getJSONObject(0).getString("answer"))
        assertEquals("Halo", detail.getString("projectName")); assertEquals(42L, detail.getLong("finalizedAt"))
        val broken = HistoryPresentation.detail(JSONObject().put("text", "{\"secret\":").put("truncated", true), JSONObject().put("preview", "安全摘要"))
        assertEquals("安全摘要", broken.getString("excerpt")); assertTrue(broken.getBoolean("incomplete")); assertFalse(broken.has("text"))
    }
    @Test fun renamePreservesSystemNameAndRejectsControlCharacters() {
        val context = rule.activity
        val previous = context.getSharedPreferences("device-name", 0).getString("custom", null)
        try {
            DeviceNames.set(context, "小米 15 😀"); assertEquals("小米 15 😀", DeviceNames.current(context))
            DeviceNames.set(context, null); assertEquals(DeviceNames.system(context), DeviceNames.current(context))
            assertEquals("😀".repeat(48), DeviceNames.checked("😀".repeat(48)))
            for (invalid in listOf(" ", "x\nx", "x\u202ex", "😀".repeat(49))) assertTrue(runCatching { DeviceNames.checked(invalid) }.isFailure)
        } finally { DeviceNames.set(context, previous) }
    }
    @Test fun readableHistoryAndSetupScreenshots() {
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        fun capture(name: String) {
            rule.waitForIdle()
            instrumentation.uiAutomation.takeScreenshot().let { bitmap -> java.io.File(rule.activity.filesDir, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
        }
        UiLanguage.mode = "zh-CN"
        rule.activity.setContent { HaloTheme { SetupScreen(true, false, {}, {}) } }
        rule.onNodeWithText("设置手机伴侣").assertIsDisplayed(); capture("setup-zh")
        val record = JSONObject().put("id", "history-fixture").put("agentId", "codex").put("agentName", "Codex").put("kind", "question")
            .put("preview", "请选择部署环境：开发、测试或生产").put("projectName", "Demo").put("sessionLabel", "session-123").put("outcome", "submit").put("finalizedAt", System.currentTimeMillis())
            .put("questions", org.json.JSONArray("[{\"question\":\"请选择部署环境\",\"answer\":\"测试\"}]"))
        val state = CompanionState(history = listOf(HistoryItem("pc", record)), historyDetails = mapOf("pc/history-fixture" to record))
        rule.activity.setContent { HaloTheme { HistoryDetailScreen(state, "pc/history-fixture") {} } }
        rule.onNodeWithText("请选择部署环境").assertIsDisplayed(); rule.onNodeWithText("回答: 测试").assertIsDisplayed(); capture("history-zh")
        UiLanguage.mode = "en-US"
        rule.activity.setContent { androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(1f, 2f)) {
            HaloTheme { SetupScreen(true, false, {}, {}) }
        } }
        rule.onNodeWithText("Continue").performScrollTo().assertIsNotEnabled(); capture("setup-en-large")
        UiLanguage.mode = "zh-CN"
    }
}
