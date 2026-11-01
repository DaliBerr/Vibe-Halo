package com.vibe.halo.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.updates.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class AppUpdateUiTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test fun updateControlsRemainReachableWithLargeTextAndOpenOnlyTheSystemInstaller() {
        val fixturePath = InstrumentationRegistry.getArguments().getString("updateApk")?.let(::File)
        assumeTrue(fixturePath?.isFile == true)
        val fixture = UpdateFixture(fixturePath!!.readBytes())
        val context = rule.activity
        val installed = InstalledUpdateApp(UPDATE_PACKAGE, "0.6.6", 6, setOf("4771d9bec52ebed7895873037cb67e97d369c52572f7bb45e4441117106d3106"))
        val manager = AppUpdateManager(context.applicationContext, fixture.http, installed)
        val allowed = manager.canInstall()
        val oldLanguage = UiLanguage.mode
        try {
            shell("appops set ${context.packageName} REQUEST_INSTALL_PACKAGES allow")
            UiLanguage.mode = "zh-CN"
            rule.activity.setContent { HaloTheme {
                CompositionLocalProvider(LocalDensity provides Density(1f, 1.8f)) {
                    Column(Modifier.size(320.dp, 420.dp).verticalScroll(rememberScrollState())) { AppUpdateCard(manager) }
                }
            } }
            rule.waitUntil(10000) { manager.state.value.phase == UpdatePhase.IDLE }
            rule.onNodeWithText("检查更新").performScrollTo().assertIsDisplayed().performClick()
            rule.waitUntil(10000) { manager.state.value.phase == UpdatePhase.AVAILABLE }
            rule.onNodeWithText("此版本有新的更新包。").performScrollTo().assertIsDisplayed()
            rule.onNodeWithText("下载更新").performScrollTo().assertIsDisplayed().performClick()
            rule.waitUntil(20000) { manager.state.value.phase == UpdatePhase.READY }
            rule.onNodeWithText("安装更新").performScrollTo().assertIsDisplayed().performClick()
            val deadline = System.currentTimeMillis() + 10000
            var installerVisible = false
            while (System.currentTimeMillis() < deadline) {
                val activity = shell("dumpsys activity activities").lineSequence().filter { it.contains("mResumedActivity") || it.contains("topResumedActivity") }.joinToString()
                if (activity.contains("packageinstaller", ignoreCase = true)) { installerVisible = true; break }
                Thread.sleep(100)
            }
            assertTrue("The system installer asks for confirmation; the app never installs silently", installerVisible)
            shell("input keyevent 4")
        } finally {
            shell("input keyevent 4")
            manager.close()
            if (!allowed) shell("appops set ${context.packageName} REQUEST_INSTALL_PACKAGES default")
            File(context.cacheDir, "apk-updates").deleteRecursively()
            UiLanguage.mode = oldLanguage
        }
    }

    private fun shell(command: String): String = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes().toString(Charsets.UTF_8)
    }
}
