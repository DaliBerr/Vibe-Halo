package com.vibe.halo.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vibe.halo.mobile.notifications.CompanionNotifications
import com.vibe.halo.mobile.notifications.NotificationRetention
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationRetentionUiTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test fun largeTextSliderSavesEveryMinuteAndSurvivesRecreationInBothLanguages() {
        val original = NotificationRetention.minutes(rule.activity); val language = UiLanguage.mode
        fun content() = rule.activity.setContent { HaloTheme {
            CompositionLocalProvider(LocalDensity provides Density(1f, 1.8f)) {
                Column(Modifier.size(320.dp, 420.dp).verticalScroll(rememberScrollState())) { NotificationRetentionCard() }
            }
        } }
        try {
            CompanionNotifications.setRetentionMinutes(rule.activity, 10); UiLanguage.mode = "zh-CN"; content()
            rule.onNodeWithText("10 分钟").assertIsDisplayed()
            for (minutes in listOf(3, 17, 30)) {
                rule.onNodeWithTag("notification-retention").performScrollTo().performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.SetProgress) { it(minutes.toFloat()) }
                rule.runOnIdle { assertEquals(minutes, NotificationRetention.minutes(rule.activity)) }
            }
            UiLanguage.mode = "en-US"; content()
            rule.onNodeWithText("30 minutes").assertIsDisplayed()
            rule.onNodeWithText("Auto-clear notifications").assertIsDisplayed()
            rule.onNodeWithText("Only clears the notification shade. Messages and pending requests stay in the app.").performScrollTo().assertIsDisplayed()
        } finally { CompanionNotifications.setRetentionMinutes(rule.activity, original); UiLanguage.mode = language }
    }
}
