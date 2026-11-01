package com.vibe.halo.mobile

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.updates.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class AppUpdateTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val installed = InstalledUpdateApp(UPDATE_PACKAGE, "0.6.6", 6,
        setOf("4771d9bec52ebed7895873037cb67e97d369c52572f7bb45e4441117106d3106"))

    @Test fun metadataAndRedirectsStayOnTheOfficialReleaseBoundary() = runBlocking {
        val update = update("synthetic APK".toByteArray())
        assertEquals(update, UpdateHttp.parseManifest(UpdateHttp.manifest(update)))
        for ((key, bad) in listOf("schema" to 2, "versionCode" to "7", "versionCode" to 7.5, "size" to -1,
            "packageName" to "other.app", "apkName" to "../private", "sha256" to "wrong", "sourceCommit" to "main")) {
            assertTrue("$key rejected", runCatching { UpdateHttp.parseManifest(UpdateHttp.manifest(update).put(key, bad)) }.isFailure)
        }
        for (url in listOf("http://github.com/DaliBerr/Vibe-Halo", "https://github.com.evil.invalid/file", "https://user@github.com/DaliBerr/Vibe-Halo/releases/download/v0.6.6/android-update.json",
            "https://github.com/another/repo/releases/download/v0.6.6/android-update.json", "https://api.github.com/user", "https://objects.githubusercontent.com:444/file")) assertFalse(url, UpdateHttp.trustedUrl(url))
        assertTrue(UpdateHttp.trustedUrl(update.apkUrl))
        assertTrue(UpdateHttp.trustedUrl("https://release-assets.githubusercontent.com/github-production-release-asset/file?token=synthetic"))
        var requests = 0
        val redirected = UpdateHttp(OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
            requests++
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(302).message("Synthetic redirect")
                .header("Location", "http://untrusted.invalid/apk").body(ByteArray(0).toResponseBody()).build()
        }.build())
        assertTrue(runCatching { redirected.latest() }.isFailure)
        assertEquals(1, requests)
    }

    @Test fun releaseDiscoverySkipsDesktopOnlyAndPreviewReleasesAndStreamsVerifiedBytes() = runBlocking {
        val bytes = ByteArray(90000) { (it % 251).toByte() }
        val fixture = UpdateFixture(bytes)
        val progress = mutableListOf<Int>()
        val directory = File(context.cacheDir, "update-stream-test").apply { mkdirs() }
        val destination = File(directory, "download.part")
        try {
            assertEquals(fixture.update, fixture.http.latest())
            fixture.http.download(fixture.update, destination) { progress += it }
            assertArrayEquals(bytes, destination.readBytes())
            assertEquals(100, progress.last())
            assertEquals(progress.sorted(), progress)
            assertTrue(fixture.requests.all { it.startsWith("https://api.github.com/") || it.startsWith("https://github.com/DaliBerr/Vibe-Halo/") })
        } finally { destination.delete(); directory.delete() }
    }

    @Test fun failedDownloadsRateLimitsAndMetadataMismatchCannotBecomeInstallable() = runBlocking {
        val bytes = "synthetic APK".toByteArray()
        val fixture = UpdateFixture(bytes)
        val file = File(context.cacheDir, "bad-update.part")
        try {
            val wrong = fixture.update.copy(sha256 = "0".repeat(64))
            val failure = runCatching { fixture.http.download(wrong, file) {} }.exceptionOrNull()
            assertEquals(UpdateProblem.PACKAGE, (failure as UpdateException).problem)
            assertFalse(file.exists())
            fixture.badManifest = true
            assertTrue(runCatching { fixture.http.latest() }.isFailure)
            fixture.rateLimit = true
            val limited = runCatching { fixture.http.latest() }.exceptionOrNull()
            assertEquals(UpdateProblem.RATE_LIMIT, (limited as UpdateException).problem)
        } finally { file.delete() }
    }

    @Test fun originalKeyApkDownloadRestoresAfterRecreationAndOnlyGrantsReadAccess() = runBlocking {
        val bytes = releaseApk().readBytes()
        val fixture = UpdateFixture(bytes)
        val directory = File(context.cacheDir, "apk-updates")
        var manager = AppUpdateManager(context, fixture.http, installed)
        val allowedBefore = manager.canInstall()
        try {
            await(manager, UpdatePhase.IDLE)
            manager.check(); await(manager, UpdatePhase.AVAILABLE)
            manager.download(); await(manager, UpdatePhase.READY)
            assertNull("No installer intent before source permission", if (!allowedBefore) manager.installIntent() else null)
            manager.close()
            manager = AppUpdateManager(context, fixture.http, installed)
            await(manager, UpdatePhase.READY)
            shell("appops set ${context.packageName} REQUEST_INSTALL_PACKAGES allow")
            assertTrue(manager.canInstall())
            val intent = manager.installIntent()!!
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals("content", intent.data!!.scheme)
            assertEquals("${context.packageName}.updates", intent.data!!.authority)
            assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            assertArrayEquals(bytes, context.contentResolver.openInputStream(intent.data!!)!!.use { it.readBytes() })
            assertEquals("package:${context.packageName}", manager.permissionIntent().data.toString())
            assertTrue(runCatching { FileProvider.getUriForFile(context, "${context.packageName}.updates", File(context.filesDir, "private")) }.isFailure)
            File(directory, "packages/update-${fixture.update.sha256}.apk").appendText("corrupted after download")
            assertNull(manager.installIntent())
            assertEquals(UpdateProblem.PACKAGE, manager.state.value.problem)
        } finally {
            manager.close()
            if (!allowedBefore) shell("appops set ${context.packageName} REQUEST_INSTALL_PACKAGES default")
            directory.deleteRecursively()
        }
    }

    @Test fun wrongSignerAndCancellationNeverLeaveAReadyUpdate() = runBlocking {
        val fixture = UpdateFixture(releaseApk().readBytes())
        val directory = File(context.cacheDir, "apk-updates")
        val manager = AppUpdateManager(context, fixture.http, installed.copy(signers = setOf("untrusted")))
        try {
            await(manager, UpdatePhase.IDLE)
            manager.check(); await(manager, UpdatePhase.AVAILABLE)
            manager.download(); await(manager, UpdatePhase.ERROR)
            assertEquals(UpdateProblem.PACKAGE, manager.state.value.problem)
            assertFalse(File(directory, "ready.json").exists())
            fixture.downloading = false
            fixture.delayApk = true
            manager.download()
            withTimeout(10000) { while (!fixture.downloading) delay(20) }
            manager.cancel()
            assertEquals(UpdatePhase.AVAILABLE, manager.state.value.phase)
            manager.check()
            await(manager, UpdatePhase.AVAILABLE)
            withTimeout(10000) { while (File(directory, "packages").listFiles().orEmpty().any { it.extension == "part" }) delay(20) }
            assertFalse(File(directory, "ready.json").exists())
        } finally { manager.close(); directory.deleteRecursively() }
    }

    private fun releaseApk(): File {
        val file = InstrumentationRegistry.getArguments().getString("updateApk")?.let(::File)
        assumeTrue("Supply -e updateApk with an original-key release APK fixture", file?.isFile == true)
        return file!!
    }

    private suspend fun await(manager: AppUpdateManager, phase: UpdatePhase) = withTimeout(20000) { manager.state.first { it.phase == phase } }
    private fun shell(command: String) = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
    private fun update(bytes: ByteArray) = AndroidUpdate("0.6.6", 7, bytes.size.toLong(), UpdateHttp.digest(bytes), "a".repeat(40))
}

internal class UpdateFixture(private val bytes: ByteArray) {
    val update = AndroidUpdate("0.6.6", 7, bytes.size.toLong(), UpdateHttp.digest(bytes), "a".repeat(40))
    val requests = mutableListOf<String>()
    var badManifest = false
    var rateLimit = false
    @Volatile var delayApk = false
    @Volatile var downloading = false
    val http = UpdateHttp(OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).addInterceptor { chain ->
        val request = chain.request()
        assertNull(request.header("Authorization")); assertNull(request.header("Cookie"))
        requests += request.url.toString()
        val manifestBytes = UpdateHttp.manifest(update).toString().toByteArray()
        val body = when {
            request.url.host == "api.github.com" -> {
                val release = JSONObject().put("draft", false).put("prerelease", false).put("tag_name", "v0.6.6").put("assets", JSONArray()
                    .put(JSONObject().put("name", "android-update.json").put("browser_download_url", "https://github.com/$UPDATE_REPOSITORY/releases/download/v0.6.6/android-update.json").put("digest", "sha256:" + if (badManifest) "0".repeat(64) else UpdateHttp.digest(manifestBytes)))
                    .put(JSONObject().put("name", update.apkName).put("browser_download_url", update.apkUrl).put("digest", "sha256:${update.sha256}").put("size", update.size)))
                JSONArray().put(JSONObject().put("draft", false).put("prerelease", false).put("tag_name", "v0.6.7").put("assets", JSONArray()))
                    .put(JSONObject(release.toString()).put("prerelease", true)).put(release).toString().toByteArray()
            }
            request.url.encodedPath.endsWith("android-update.json") -> manifestBytes
            else -> {
                downloading = true
                if (delayApk) { Thread.sleep(1000); if (chain.call().isCanceled()) throw IOException("Synthetic cancellation") }
                bytes
            }
        }
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(if (rateLimit) 429 else 200).message("Synthetic update")
            .body(body.toResponseBody("application/octet-stream".toMediaType())).build()
    }.build())
}
