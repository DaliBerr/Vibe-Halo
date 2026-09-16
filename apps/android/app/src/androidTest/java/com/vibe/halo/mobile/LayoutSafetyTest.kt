package com.vibe.halo.mobile

import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.size
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vibe.halo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LayoutSafetyTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test fun allActionsRemainReachableOnShortScreenWithLargeText() {
        val repository = CompanionRepository(rule.activity)
        val summary = JSONObject().put("kind", "approval").put("agentId", "synthetic").put("state", "pending").put("eventRevision", 1)
        val detail = JSONObject().put("summary", summary).put("toolName", "Bash").put("description", "Synthetic layout context")
            .put("toolInputText", "echo layout-only").put("questions", JSONArray())
            .put("options", JSONArray((0..11).map { JSONObject().put("id", "layout-$it").put("label", "Option $it") }))
        val event = RemoteEvent("layout-only", "unbound", detail, 0)
        rule.activity.setContentForLayoutTest {
            CompositionLocalProvider(LocalDensity provides Density(1f, 2f)) {
                HaloTheme { EventScreen(event, CompanionState(), repository, Modifier.size(320.dp, 420.dp)) {} }
            }
        }
        rule.onNodeWithText("Option 0").assertIsDisplayed().assertIsNotEnabled()
        rule.onNodeWithText("Option 11").performScrollTo().assertIsDisplayed().assertIsNotEnabled()
        repository.close()
    }
}

private fun MainActivity.setContentForLayoutTest(content: @androidx.compose.runtime.Composable () -> Unit) {
    setContent(content = content)
}
