package com.vibe.halo.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.vibe.halo.mobile.data.CompanionRepository
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/** Opt-in setup only: leaves the synthetic PC bound for a post-instrumentation
 * background FCM check. The caller must revoke the test PC after observing it. */
@RunWith(AndroidJUnit4::class)
class PublicPushSetupTest {
    @Test fun enrollSyntheticPcAndRegisterRealPushToken() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("publicPush") == "1")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val config = JSONObject(File(context.filesDir, "mobile-smoke-config.json").readText())
        require(config.getString("relayOrigin").startsWith("https://"))
        assertTrue("Firebase must be configured for this build", FirebaseApp.getApps(context).isNotEmpty())
        val repo = CompanionRepository(context)
        try {
            repo.load()
            repo.beginPairing(config.getString("relayOrigin"), config.getString("code"))
            assertNotNull(repo.state.value.message, repo.state.value.pairing)
            val connection = URL(config.getString("bridgeOrigin") + "/confirm").openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Authorization", "Bearer ${config.getString("bridgeToken")}")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.doOutput = true
                connection.outputStream.use { it.write(JSONObject().put("fingerprint", repo.state.value.pairing!!.fingerprint).toString().toByteArray()) }
                assertEquals(200, connection.responseCode)
                connection.inputStream.close()
            } finally { connection.disconnect() }
            repo.pollPairing(); repo.finishPairing()
            assertNull(repo.state.value.message, repo.state.value.pairing)
            assertTrue(repo.state.value.computers.any { it.pcId == config.getString("pcId") && it.state == "active" })
            @Suppress("DEPRECATION") val token = Tasks.await(FirebaseMessaging.getInstance().token, 60, TimeUnit.SECONDS)
            assertTrue("FCM registration token unavailable", token.length >= 20)
            repo.registerPushToken(token)
            // The token stays in encrypted app/relay storage, never test output.
            assertFalse(repo.state.value.message, repo.state.value.message.contains("失败"))
        } finally { repo.close() }
    }
}
