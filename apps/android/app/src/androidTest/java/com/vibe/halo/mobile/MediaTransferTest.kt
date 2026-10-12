package com.vibe.halo.mobile

import android.graphics.BitmapFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.data.*
import com.vibe.halo.mobile.security.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

@RunWith(AndroidJUnit4::class)
class MediaTransferTest {
    @Test fun encryptedPcSnapshotLoadsThroughRepositoryAndSurvivesSourceRemoval() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val configFile = File(context.filesDir, "media-e2e-config.json")
        assumeTrue("Start scripts/mobile-media-smoke-host.cjs and copy the local fixture first", configFile.exists())
        val config = JSONObject(configFile.readText()); val origin = config.getString("origin")
        fun bridge(route: String, value: JSONObject = JSONObject()): JSONObject {
            val connection = URL(origin + route).openConnection() as HttpURLConnection
            connection.requestMethod = "POST"; connection.setRequestProperty("Authorization", "Bearer ${config.getString("bridgeToken")}")
            connection.setRequestProperty("Content-Type", "application/json"); connection.doOutput = true
            connection.connectTimeout = 10000; connection.readTimeout = 10000
            connection.outputStream.use { it.write(value.toString().toByteArray()) }
            return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }.also { connection.disconnect() }
        }
        val store = SecureStore(context, origin); val device = DeviceCrypto(context, store)
        val registry = SecureStore(context); val originalRegistry = registry.read(); val originalData = store.read()
        val setup = bridge("/setup", JSONObject().put("mobile", device.publicDevice))
        val grant = setup.getJSONObject("grant"); val pcKey = "$origin/${grant.getString("bindingId")}"
        val repo = CompanionRepository(context)
        try {
            registry.update { it.put("origins", JSONArray().put(origin)) }
            store.update { it.put("bindings", JSONArray().put(JSONObject().put("state", "active").put("grant", grant).put("grantJws", setup.getString("grantJws")))) }
            repo.load(false); assertEquals(repo.state.value.message, 1, repo.state.value.computers.size)
            val source = MediaSource(pcKey, "event", setup.getString("sourceId"), setup.getString("epoch"))
            val items = repo.listMedia(source); assertEquals(1, items.size)
            assertTrue(bridge("/delete-original").getBoolean("deleted"))
            val preview = repo.loadMedia(source, items.single(), false)
            val full = repo.loadMedia(source, items.single(), true)
            assertTrue(full.isNotEmpty()); assertNotNull(BitmapFactory.decodeByteArray(preview, 0, preview.size))
            val image = BitmapFactory.decodeByteArray(full, 0, full.size)
            assertEquals(items.single().full.width, image.width); assertEquals(items.single().full.height, image.height)
            assertArrayEquals(full, repo.loadMedia(source, items.single(), true))
            val wrong = items.single().copy(full = items.single().full.copy(sha256 = "f".repeat(64)))
            assertTrue(runCatching { repo.loadMedia(source, wrong, true) }.isFailure)
            assertTrue(runCatching { repo.listMedia(source.copy(epoch = "00000000-0000-0000-0000-000000000000")) }.isFailure)
        } finally { repo.close(); registry.write(originalRegistry); store.write(originalData) }
    }
}
