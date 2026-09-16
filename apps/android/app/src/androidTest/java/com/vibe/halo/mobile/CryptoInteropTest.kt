package com.vibe.halo.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.security.DeviceCrypto
import com.vibe.halo.mobile.security.SecureStore
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class CryptoInteropTest {
    @Test fun canonicalTranscriptEscapes() {
        assertEquals("{\"origin\":\"https://relay.test\",\"text\":\"中文🚀\\n\"}", DeviceCrypto.canonical(JSONObject().put("text", "中文🚀\n").put("origin", "https://relay.test")))
    }
    @Test fun exportPublic() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val crypto = DeviceCrypto(context, SecureStore(context))
        File(context.filesDir, "interop-public.json").writeText(crypto.publicDevice.toString())
        val restored = DeviceCrypto(context, SecureStore(context))
        assertEquals(crypto.publicDevice.toString(), restored.publicDevice.toString())
    }
    @Test fun roundTrip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val crypto = DeviceCrypto(context, SecureStore(context))
        val input = JSONObject(File(context.filesDir, "interop-input.json").readText())
        val node = input.getJSONObject("node")
        val clear = crypto.open(input.getString("envelope"), node.getJSONObject("signKey"))
        assertEquals("中文🚀\n精确上下文", clear.getString("text"))
        assertEquals(crypto.publicDevice.getString("deviceId"), clear.getString("mobileId"))
        val response = crypto.seal(clear.put("androidVerified", true), node.getJSONObject("encryptionKey"))
        File(context.filesDir, "interop-response.json").writeText(JSONObject().put("envelope", response).toString())
        val parts = input.getString("envelope").split(".").toMutableList()
        parts[3] = (if (parts[3][0] == 'A') "B" else "A") + parts[3].drop(1)
        assertThrows(Exception::class.java) { crypto.open(parts.joinToString("."), node.getJSONObject("signKey")) }
    }
}
