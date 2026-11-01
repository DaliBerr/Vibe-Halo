package com.vibe.halo.mobile.updates

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap

class UpdateHttp(private val client: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(3, TimeUnit.MINUTES)
    .followRedirects(false).followSslRedirects(false).build()) {
    private val calls = ConcurrentHashMap.newKeySet<Call>()
    fun cancel() { calls.forEach { it.cancel() } }

    suspend fun latest(): AndroidUpdate? = withContext(Dispatchers.IO) {
        val releases = JSONArray(String(bytes("https://api.github.com/repos/$UPDATE_REPOSITORY/releases?per_page=20", 2 * 1024 * 1024), Charsets.UTF_8))
        require(releases.length() <= 20)
        for (i in 0 until releases.length()) {
            val release = releases.getJSONObject(i)
            if (release.opt("draft") != false || release.opt("prerelease") != false) continue
            val tag = release.optString("tag_name")
            if (!Regex("v[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}").matches(tag)) continue
            val assets = release.getJSONArray("assets")
            require(assets.length() <= 200)
            val manifestAsset = (0 until assets.length()).map { assets.getJSONObject(it) }.singleOrNull { it.optString("name") == "android-update.json" } ?: continue
            val manifestUrl = "https://github.com/$UPDATE_REPOSITORY/releases/download/$tag/android-update.json"
            require(manifestAsset.getString("browser_download_url") == manifestUrl)
            val manifest = bytes(manifestUrl, 16 * 1024)
            require(manifestAsset.getString("digest") == "sha256:${digest(manifest)}")
            val update = parseManifest(JSONObject(String(manifest, Charsets.UTF_8)))
            require(update.tag == tag)
            val apk = (0 until assets.length()).map { assets.getJSONObject(it) }.single { it.optString("name") == update.apkName }
            require(apk.getString("browser_download_url") == update.apkUrl && apk.getString("digest") == "sha256:${update.sha256}" && integer(apk, "size") == update.size)
            return@withContext update
        }
        null
    }

    suspend fun download(update: AndroidUpdate, destination: File, progress: (Int) -> Unit) = withContext(Dispatchers.IO) {
        update.checked()
        var call: Call? = null
        try {
            val exchange = response(update.apkUrl)
            call = exchange.second
            exchange.first.use { response ->
                val body = response.body
                require(body.contentLength() == -1L || body.contentLength() == update.size)
                val hash = MessageDigest.getInstance("SHA-256")
                var total = 0L
                body.byteStream().use { input -> destination.outputStream().use { output ->
                    val buffer = ByteArray(32 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) { break }
                        total += count
                        require(total <= update.size && total <= MAX_APK_BYTES)
                        hash.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                        progress((total * 100 / update.size).toInt().coerceIn(0, 100))
                    }
                } }
                require(total == update.size && hex(hash.digest()) == update.sha256)
            }
        } catch (error: Exception) {
            destination.delete()
            if (error is IllegalArgumentException) throw UpdateException(UpdateProblem.PACKAGE)
            throw error
        } finally { call?.let { calls.remove(it) } }
    }

    private suspend fun bytes(url: String, limit: Int): ByteArray {
        var call: Call? = null
        try {
            val exchange = response(url)
            call = exchange.second
            return exchange.first.use { response ->
                require(response.body.contentLength() <= limit)
                response.body.byteStream().use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) { break }
                        require(output.size() + count <= limit)
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
            }
        } finally { call?.let { calls.remove(it) } }
    }

    private suspend fun response(initial: String): Pair<Response, Call> {
        var url = initial.toHttpUrl()
        repeat(6) {
            currentCoroutineContext().ensureActive()
            require(trustedUrl(url.toString()))
            val call = client.newCall(Request.Builder().url(url).header("Accept", "application/vnd.github+json")
                .header("User-Agent", "Vibe-Halo-Android-Updater").build())
            calls.add(call)
            val result = try { call.execute() } catch (error: Exception) { calls.remove(call); throw error }
            if (result.code in listOf(301, 302, 303, 307, 308)) {
                val location = result.header("Location")
                result.close()
                calls.remove(call)
                url = location?.let { url.resolve(it) } ?: throw UpdateException(UpdateProblem.NETWORK)
            } else {
                if (!result.isSuccessful) {
                    val limited = result.code == 403 || result.code == 429
                    result.close()
                    calls.remove(call)
                    throw UpdateException(if (limited) UpdateProblem.RATE_LIMIT else UpdateProblem.NETWORK)
                }
                return result to call
            }
        }
        throw UpdateException(UpdateProblem.NETWORK)
    }

    companion object {
        fun trustedUrl(value: String): Boolean = runCatching {
            val url = value.toHttpUrl()
            url.scheme == "https" && url.port == 443 && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null && when (url.host) {
                "api.github.com" -> url.encodedPath == "/repos/$UPDATE_REPOSITORY/releases"
                "github.com" -> Regex("/DaliBerr/Vibe-Halo/releases/download/v[0-9.]+/(android-update\\.json|Vibe-Halo-Mobile-[0-9.]+\\.apk)").matches(url.encodedPath)
                "release-assets.githubusercontent.com", "objects.githubusercontent.com" -> true
                else -> false
            }
        }.getOrDefault(false)

        fun parseManifest(json: JSONObject): AndroidUpdate {
            require(integer(json, "schema") == 1L && json.getString("packageName") == UPDATE_PACKAGE)
            val update = AndroidUpdate(json.getString("versionName"), integer(json, "versionCode"), integer(json, "size"),
                json.getString("sha256"), json.getString("sourceCommit")).checked()
            require(json.getString("apkName") == update.apkName)
            return update
        }

        fun manifest(update: AndroidUpdate): JSONObject = JSONObject().put("schema", 1).put("packageName", UPDATE_PACKAGE)
            .put("versionName", update.versionName).put("versionCode", update.versionCode).put("size", update.size)
            .put("sha256", update.sha256).put("sourceCommit", update.sourceCommit).put("apkName", update.apkName)

        private fun integer(json: JSONObject, key: String): Long {
            val value = json.get(key)
            require(value is Int || value is Long)
            return (value as Number).toLong()
        }
        fun digest(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
