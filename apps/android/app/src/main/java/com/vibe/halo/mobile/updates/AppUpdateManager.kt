package com.vibe.halo.mobile.updates

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

enum class UpdatePhase { IDLE, CHECKING, CURRENT, AVAILABLE, DOWNLOADING, VERIFYING, READY, ERROR }
data class AppUpdateState(val phase: UpdatePhase = UpdatePhase.IDLE, val update: AndroidUpdate? = null, val progress: Int = 0, val problem: UpdateProblem? = null)

class AppUpdateManager(
    private val context: Context,
    private val http: UpdateHttp = UpdateHttp(),
    private val installed: InstalledUpdateApp = installedApp(context),
    private val directory: File = File(context.cacheDir, "apk-updates"),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow(AppUpdateState())
    val state = mutableState.asStateFlow()
    val supported get() = installed.packageName == UPDATE_PACKAGE
    private var job: Job? = null
    private var generation = 0
    private val packages get() = File(directory, "packages")
    private val saved get() = File(directory, "ready.json")
    private fun apk(update: AndroidUpdate) = File(packages, "update-${update.sha256}.apk")

    init {
        start(UpdatePhase.VERIFYING) {
            val cached = withContext(Dispatchers.IO) {
                val result = runCatching {
                    require(saved.isFile && saved.length() in 1..16 * 1024)
                    val update = UpdateHttp.parseManifest(JSONObject(saved.readText()))
                    verifyApk(context, apk(update), update, installed)
                    update
                }.getOrNull()
                packages.listFiles()?.filter { result == null || it != apk(result) }?.forEach { it.delete() }
                if (result == null) saved.delete()
                File(directory, "ready.part").delete()
                result
            }
            mutableState.value = if (cached != null) AppUpdateState(UpdatePhase.READY, cached) else AppUpdateState()
        }
    }

    fun check() {
        if (!supported) return
        start(UpdatePhase.CHECKING) {
            val latest = http.latest()
            mutableState.value = if (latest?.newerThan(installed) == true) AppUpdateState(UpdatePhase.AVAILABLE, latest) else AppUpdateState(UpdatePhase.CURRENT)
        }
    }

    fun download() {
        val update = state.value.update ?: return
        if (state.value.phase !in listOf(UpdatePhase.AVAILABLE, UpdatePhase.ERROR)) return
        start(UpdatePhase.DOWNLOADING, update) {
            val token = generation
            val partial = File(packages, "download-$token.part")
            try {
                withContext(Dispatchers.IO) { check(packages.mkdirs() || packages.isDirectory); partial.delete() }
                http.download(update, partial) { percent ->
                    if (generation == token) mutableState.value = AppUpdateState(UpdatePhase.DOWNLOADING, update, percent)
                }
                mutableState.value = AppUpdateState(UpdatePhase.VERIFYING, update)
                withContext(Dispatchers.IO) {
                    verifyApk(context, partial, update, installed)
                    ensureActive()
                    check(partial.renameTo(apk(update)))
                    val temp = File(directory, "ready.part")
                    temp.writeText(UpdateHttp.manifest(update).toString())
                    check(temp.renameTo(saved))
                    packages.listFiles()?.filter { it != apk(update) }?.forEach { it.delete() }
                }
                mutableState.value = AppUpdateState(UpdatePhase.READY, update, 100)
            } finally { withContext(NonCancellable + Dispatchers.IO) { partial.delete() } }
        }
    }

    fun cancel() {
        generation++
        job?.cancel()
        http.cancel()
        job = null
        val update = state.value.update
        mutableState.value = if (update != null) AppUpdateState(UpdatePhase.AVAILABLE, update) else AppUpdateState()
    }

    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()
    fun permissionIntent(): Intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))

    suspend fun installIntent(): Intent? {
        val current = state.value
        if (current.phase != UpdatePhase.READY || !canInstall()) return null
        val update = current.update ?: return null
        mutableState.value = current.copy(phase = UpdatePhase.VERIFYING)
        return try {
            withContext(Dispatchers.IO) { verifyApk(context, apk(update), update, installed) }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk(update))
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = ClipData.newRawUri("Vibe Halo update", uri) }
            mutableState.value = current
            intent
        } catch (error: CancellationException) { mutableState.value = current; throw error }
        catch (_: Exception) {
            mutableState.value = AppUpdateState(UpdatePhase.ERROR, update, problem = UpdateProblem.PACKAGE)
            null
        }
    }

    fun installerUnavailable() { mutableState.value = state.value.copy(phase = UpdatePhase.ERROR, problem = UpdateProblem.INSTALLER) }

    private fun start(phase: UpdatePhase, update: AndroidUpdate? = null, action: suspend () -> Unit) {
        if (state.value.phase in listOf(UpdatePhase.CHECKING, UpdatePhase.DOWNLOADING, UpdatePhase.VERIFYING)) return
        val token = ++generation
        mutableState.value = AppUpdateState(phase, update)
        val next = scope.launch(start = CoroutineStart.LAZY) {
            try { action() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (token == generation) mutableState.value = AppUpdateState(UpdatePhase.ERROR, update, problem = when (error) {
                    is UpdateException -> error.problem
                    is IllegalArgumentException, is org.json.JSONException -> UpdateProblem.METADATA
                    else -> UpdateProblem.NETWORK
                })
            } finally { if (token == generation) job = null }
        }
        job = next
        next.start()
    }

    fun close() { cancel(); scope.cancel() }

    companion object {
        @Suppress("DEPRECATION")
        private fun signingFlags(): Int = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

        @Suppress("DEPRECATION")
        private fun appInfo(info: PackageInfo): InstalledUpdateApp {
            val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
            return InstalledUpdateApp(info.packageName, info.versionName.orEmpty(), if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong(),
                signatures.orEmpty().map { UpdateHttp.digest(it.toByteArray()) }.toSet())
        }

        @Suppress("DEPRECATION")
        fun installedApp(context: Context): InstalledUpdateApp = appInfo(context.packageManager.getPackageInfo(context.packageName, signingFlags()))

        @Suppress("DEPRECATION")
        fun verifyApk(context: Context, file: File, update: AndroidUpdate, installed: InstalledUpdateApp) {
            try {
                require(file.isFile && file.length() == update.size && update.newerThan(installed))
                val hash = MessageDigest.getInstance("SHA-256")
                file.inputStream().use { input -> val buffer = ByteArray(32 * 1024); while (true) {
                    val count = input.read(buffer); if (count < 0) break; hash.update(buffer, 0, count)
                } }
                require(UpdateHttp.hex(hash.digest()) == update.sha256)
                val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath, signingFlags()) ?: error("Invalid APK")
                require(validUpdateArchive(update, installed, appInfo(archive), archive.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE, Build.VERSION.SDK_INT))
            } catch (_: Exception) { throw UpdateException(UpdateProblem.PACKAGE) }
        }
    }
}

class UpdateFileProvider : FileProvider()
