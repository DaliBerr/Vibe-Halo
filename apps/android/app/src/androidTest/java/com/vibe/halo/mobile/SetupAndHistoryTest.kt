package com.vibe.halo.mobile

import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
    @org.junit.Before fun resetWizard() { SetupProgress(rule.activity).step = 0; UiLanguage.mode = "zh-CN" }
    @Test fun setupRequiresPairingAndDoesNotTreatSkippedPermissionsAsCompleted() {
        UiLanguage.mode = "zh-CN"
        var paired by mutableStateOf(false); var finished = false
        rule.activity.setContent { HaloTheme { SetupScreen(true, paired, {}, { finished = true }) } }
        rule.onNodeWithText("下一步").assertIsNotEnabled()
        assertFalse(finished)
        rule.runOnUiThread { paired = true }
        rule.waitUntil(5000) { SetupProgress(rule.activity).step >= 1 }
        if (setupChecks(rule.activity).notifications) rule.waitUntil(5000) { SetupProgress(rule.activity).step == 2 }
        else rule.onNodeWithText("稍后设置").performClick()
        rule.onNodeWithText("后台锁定").assertIsDisplayed()
        rule.onNodeWithText("我已完成").assertDoesNotExist()
        rule.onNodeWithText("下一步").performClick()
        rule.onNodeWithText("进入应用").assertIsDisplayed().performClick()
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
        rule.onNodeWithText("1 / 4").assertIsDisplayed(); capture("setup-zh")
        val record = JSONObject().put("id", "history-fixture").put("agentId", "codex").put("agentName", "Codex").put("kind", "question")
            .put("preview", "请选择部署环境：开发、测试或生产").put("projectName", "Demo").put("sessionLabel", "session-123").put("outcome", "submit").put("finalizedAt", System.currentTimeMillis())
            .put("questions", org.json.JSONArray("[{\"question\":\"请选择部署环境\",\"answer\":\"测试\"}]"))
        val state = CompanionState(history = listOf(HistoryItem("pc", record)), historyDetails = mapOf("pc/history-fixture" to record))
        rule.activity.setContent { HaloTheme { HistoryDetailScreen(state, "pc/history-fixture") {} } }
        rule.onAllNodesWithText("请选择部署环境").onFirst().assertIsDisplayed(); capture("history-zh")
        rule.onNodeWithText("回答: 测试").performScrollTo().assertIsDisplayed()
        UiLanguage.mode = "en-US"
        rule.activity.setContent { androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(1f, 2f)) {
            HaloTheme { SetupScreen(true, false, {}, {}) }
        } }
        rule.onNodeWithText("Next").assertIsDisplayed().assertIsNotEnabled(); capture("setup-en-large")
        UiLanguage.mode = "zh-CN"
    }

    @Test fun realEventEnvelopeNeverBecomesVisibleJson() {
        val summary = JSONObject().put("protocolVersion", 1).put("eventId", "evt_private_internal").put("kind", "completion").put("agentId", "codex").put("state", "resolved").put("createdAt", "2026-09-17T16:39:12.813Z")
        val detail = JSONObject().put("summary", summary).put("description", "界面修改完成").put("toolInputText", "已修复历史记录，测试通过。")
        val event = RemoteEvent("fixture", "pc", detail, 0)
        val view = HistoryPresentation.model(detail)
        assertEquals("任务已完成", view.result); assertEquals("已修复历史记录，测试通过。", view.excerpt)
        assertFalse(HistoryPresentation.preview(detail).contains("protocolVersion"))
        rule.activity.setContent { HaloTheme { HistoryDetailScreen(CompanionState(events = listOf(event)), "event:fixture") {} } }
        rule.onNodeWithText("标题与类别").assertIsDisplayed()
        rule.onNodeWithText("已修复历史记录，测试通过。").performScrollTo().assertIsDisplayed()
        rule.onAllNodesWithText("protocolVersion", substring = true).assertCountEquals(0)
        rule.onAllNodesWithText("evt_private_internal", substring = true).assertCountEquals(0)
        rule.activity.setContent { HaloTheme { HistorySummaryCard(view, "RETARD") {} } }
        rule.onNodeWithText("已修复历史记录，测试通过。").assertIsDisplayed()
        rule.onAllNodesWithText("protocolVersion", substring = true).assertCountEquals(0)
    }

    @Test fun parsesQuestionArraysToolFieldsAndIncompleteRecords() {
        val input = JSONObject().put("summary", JSONObject().put("kind", "input").put("state", "resolved")).put("toolInputText", "[{\"question\":\"选哪个环境？\",\"options\":[{\"label\":\"开发\"},{\"label\":\"测试\"},{\"label\":\"生产\"}]}]")
        val question = HistoryPresentation.model(input)
        assertEquals(listOf("开发", "测试", "生产"), question.questions.single().options)
        assertEquals("", question.questions.single().answer); assertEquals("已结束", question.result)
        val approval = HistoryPresentation.model(JSONObject().put("kind", "approval").put("outcome", "deny").put("toolInputText", "{\"command\":\"echo hello\",\"token\":\"never display\"}"))
        assertEquals(listOf("命令" to "echo hello"), approval.fields); assertEquals("已拒绝", approval.result)
        assertTrue(HistoryPresentation.model(JSONObject().put("toolInputText", "{bad")).unavailable)
        assertEquals("", HistoryPresentation.preview(JSONObject().put("summary", JSONObject().put("protocolVersion", 1))))
        val plan = HistoryPresentation.model(JSONObject().put("kind", "plan").put("toolInputText", "正文".repeat(3000)))
        assertEquals(2400, plan.excerpt.length); assertTrue(plan.shortened)
        assertEquals("", HistoryPresentation.model(JSONObject().put("description", JSONObject().put("secret", "hidden"))).title)
    }

    @Test fun wizardProgressRestoresWithoutConvertingVisitsToSuccess() {
        val progress = SetupProgress(rule.activity)
        progress.step = 2; progress.visited(2)
        assertEquals(2, SetupProgress(rule.activity).step)
        rule.activity.setContent { HaloTheme { SetupScreen(false, true, {}, {}) } }
        rule.onNodeWithText("3 / 4").assertIsDisplayed()
        rule.onNodeWithText("下一步").assertIsDisplayed().performClick()
        assertEquals(3, SetupProgress(rule.activity).step)
        rule.onNodeWithText("我已完成").assertDoesNotExist()
        rule.onNodeWithText("上一步").performClick()
        rule.onNodeWithText("3 / 4").assertIsDisplayed()
    }

    @Test fun upgradeAndRestartPreserveTheGateAndDoNotTrustOldManualFlags() {
        val context = rule.activity
        val name = "wizard-migration-test"
        val prefs = context.getSharedPreferences(name, 0)
        try {
            prefs.edit().clear().putString("lock", "confirmed").apply()
            assertFalse(SetupProgress(context, name).initialize(false))
            assertFalse(SetupProgress(context, name).initialize(true)) // New installation must finish the wizard.
            prefs.edit().clear().apply()
            assertTrue(SetupProgress(context, name).initialize(true)) // Existing pairing upgrades directly.
            assertTrue(SetupProgress(context, name).initialize(false)) // Revocation does not lock the app again.
            SetupProgress(context, name).step = 3
            assertEquals(3, SetupProgress(context, name).step)
        } finally { prefs.edit().clear().apply() }
    }

    @Test fun notificationPermissionIsRecheckedAfterReturningFromSettings() {
        var enabled = false
        SetupProgress(rule.activity).step = 1
        rule.activity.setContent { HaloTheme { SetupScreen(false, true, {}, {}, checksProvider = { SetupChecks(enabled, emptyList(), false, false) }) } }
            rule.onNodeWithText("2 / 4").assertIsDisplayed()
            rule.onNodeWithText("稍后设置").assertIsDisplayed()
            rule.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            enabled = true
            rule.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            rule.waitUntil(5000) { SetupProgress(rule.activity).step == 2 }
            rule.onNodeWithText("3 / 4").assertIsDisplayed()
    }

    @Test fun batteryStepActionsStayVisibleOnSmallScreenWithLargeText() {
        UiLanguage.mode = "en-US"
        SetupProgress(rule.activity).step = 3
        rule.activity.setContent { androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(1f, 2f)) {
            HaloTheme { androidx.compose.foundation.layout.Box(Modifier.size(320.dp, 480.dp)) { SetupScreen(false, true, {}, {}) } }
        } }
        rule.onNodeWithText("Open app info").assertIsDisplayed()
        rule.onNodeWithText("Done").assertIsDisplayed()
        rule.onNodeWithText("Back").assertIsDisplayed()
        rule.onNodeWithText("Allow background activity or disable optimization in this app's battery settings.").assertIsDisplayed()
        for (label in listOf("Open app info", "Done", "Back")) {
            val bounds = rule.onNodeWithText(label).fetchSemanticsNode().boundsInRoot
            assertTrue("$label must stay within the 480px layout: $bounds", bounds.top >= 0 && bounds.bottom <= 480)
        }
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            java.io.File(rule.activity.filesDir, "wizard-battery-large.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
}
