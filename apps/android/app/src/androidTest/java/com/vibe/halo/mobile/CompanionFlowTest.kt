package com.vibe.halo.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.data.CompanionRepository
import com.vibe.halo.mobile.data.PinnedLan
import okhttp3.Request
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

@RunWith(AndroidJUnit4::class)
class CompanionFlowTest {
    @Test fun pairedCloudApproval() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val config = JSONObject(File(context.filesDir, "mobile-smoke-config.json").readText())
        fun bridge(path: String, value: JSONObject = JSONObject()): JSONObject {
            val connection = URL(config.getString("bridgeOrigin") + path).openConnection() as HttpURLConnection
            connection.requestMethod = "POST"; connection.setRequestProperty("Authorization", "Bearer ${config.getString("bridgeToken")}")
            connection.setRequestProperty("Content-Type", "application/json"); connection.doOutput = true
            connection.connectTimeout = 10000; connection.readTimeout = 10000
            connection.outputStream.use { it.write(value.toString().toByteArray()) }
            val stream = if (connection.responseCode < 400) connection.inputStream else connection.errorStream
            val result = JSONObject(stream.bufferedReader().use { it.readText() }); connection.disconnect()
            require(!result.has("error")) { result.optString("error") }; return result
        }
        val repo = CompanionRepository(context); repo.load()
        repo.beginPairing(config.getString("relayOrigin"), config.getString("code"))
        assertNotNull(repo.state.value.message, repo.state.value.pairing)
        val pairing = repo.state.value.pairing!!
        assertFalse(pairing.confirmedOnPc)
        assertTrue(bridge("/confirm", JSONObject().put("fingerprint", pairing.fingerprint)).getBoolean("confirmed"))
        repo.pollPairing(); assertTrue(repo.state.value.message, repo.state.value.pairing!!.confirmedOnPc)
        repo.finishPairing(); assertNull(repo.state.value.message, repo.state.value.pairing)
        val pc = repo.state.value.computers.first { it.pcId == config.getString("pcId") }
        assertEquals("active", pc.state)
        val originalName = com.vibe.halo.mobile.data.DeviceNames.current(context)
        repo.renameDevice("Synthetic 小米 15")
        assertTrue(bridge("/names").getJSONArray("phones").toString().contains("Synthetic 小米 15"))
        bridge("/rename", JSONObject().put("name", "Synthetic RETARD"))
        repo.refresh()
        assertEquals("Synthetic RETARD", repo.state.value.computers.first { it.key == pc.key }.name)
        repo.loadHistory(pc.key)
        val record = repo.state.value.history.first { it.computerKey == pc.key }.record
        assertEquals("请选择部署环境", record.getString("preview"))
        assertEquals("Demo", record.getString("projectName"))
        repo.loadHistoryDetail(pc.key, record.getString("id"))
        val readable = repo.state.value.historyDetails["${pc.key}/${record.getString("id")}"]!!
        assertEquals("测试", readable.getJSONArray("questions").getJSONObject(0).getString("answer"))
        assertFalse(readable.has("text"))
        repo.renameDevice(originalName)
        val request = bridge("/request")
        delay(1600) // The cloud event is already cached before this phone opens it.
        repo.refresh()
        val event = repo.state.value.events.firstOrNull { it.summary.getString("eventId") == request.getString("eventId") }
        assertNotNull(repo.state.value.message, event)
        assertTrue(repo.state.value.message, repo.actionable(event!!))
        assertTrue("Opening a cached event must not restart its 120-second lifetime", repo.remainingSeconds(event)!! <= 119)
        assertEquals("{\"command\":\"echo synthetic-mobile-test\"}", event.detail.getString("toolInputText"))
        repo.decide(event.key, "allow")
        repeat(10) { repo.checkReceipts(); if (bridge("/status").getJSONArray("outputs").length() == 0) Thread.sleep(300) }
        val status = bridge("/status")
        assertEquals(repo.state.value.message, 1, status.getJSONArray("outputs").length())
        assertEquals("allow", status.getJSONArray("outputs").getJSONObject(0).getString("optionId"))
        assertTrue(repo.state.value.message, repo.state.value.message.contains("电脑已接受"))
        repo.refresh(); assertFalse(repo.actionable(repo.state.value.events.first { it.key == event.key }))
        // Emulator-only loopback forwarding; discovery authenticity is still
        // enforced by the real pinned TLS client and signed LAN challenge.
        val discovered = repo.discovery.javaClass.getDeclaredField("found").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST") val endpoints = discovered.get(repo.discovery) as MutableMap<String, Pair<String, Long>>
        val endpoint = "https://127.0.0.1:${config.getInt("lanPort")}"
        endpoints[pc.pcId] = endpoint to System.currentTimeMillis() + 120000
        assertThrows(Exception::class.java) {
            PinnedLan.client("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").newCall(Request.Builder().url("$endpoint/v1/events").build()).execute().close()
        }
        bridge("/cloud-disconnect")
        val lanRequest = bridge("/request")
        repo.refresh()
        assertEquals("lan", repo.state.value.computers.first { it.key == pc.key }.transport)
        val lanEvent = repo.state.value.events.first { it.summary.getString("eventId") == lanRequest.getString("eventId") }
        assertTrue(repo.actionable(lanEvent))
        repo.decide(lanEvent.key, "deny")
        assertTrue(repo.state.value.message, repo.state.value.message.contains("电脑已接受"))
        assertEquals(2, bridge("/status").getJSONArray("outputs").length())
        delay(200)
        val lanHint = async(start = CoroutineStart.UNDISPATCHED) { withTimeout(5000) { repo.updates.first() } }
        val formRequest = bridge("/request", JSONObject().put("kind", "question"))
        lanHint.await()
        repo.refresh()
        val form = repo.state.value.events.first { it.summary.getString("eventId") == formRequest.getString("eventId") }
        assertTrue(repo.actionable(form))
        assertEquals(3, form.detail.getJSONArray("questions").length())
        repo.decide(form.key, "submit", JSONObject().put("environment", "unknown").put("checks", org.json.JSONArray(listOf("unit"))).put("note", "中文🚀"))
        assertEquals(2, bridge("/status").getJSONArray("outputs").length())
        repo.refresh()
        repo.decide(form.key, "submit", JSONObject().put("environment", "dev").put("checks", org.json.JSONArray(listOf("unit", "flow"))).put("note", "中文🚀"))
        val formOutputs = bridge("/status").getJSONArray("outputs")
        assertEquals(repo.state.value.message, 3, formOutputs.length())
        val encoded = formOutputs.getJSONObject(2).getJSONObject("encoded")
        assertEquals("allow", encoded.getString("decision"))
        assertEquals("中文🚀", encoded.getJSONObject("answers").getString("note"))
        assertEquals(2, encoded.getJSONObject("answers").getJSONArray("checks").length())
        bridge("/revoke"); repo.refresh()
        assertEquals("revoked", repo.state.value.computers.first { it.key == pc.key }.state)
        assertFalse(repo.state.value.events.any { it.computerKey == pc.key })
        repo.close()
    }
}
