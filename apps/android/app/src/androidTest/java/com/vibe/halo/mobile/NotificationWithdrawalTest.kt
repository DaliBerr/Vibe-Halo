package com.vibe.halo.mobile

import android.app.NotificationManager
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.google.firebase.messaging.RemoteMessage
import com.vibe.halo.mobile.notifications.*
import com.vibe.halo.mobile.security.DeviceCrypto
import com.vibe.halo.mobile.security.SecureStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NotificationWithdrawalTest {
    @Test fun onlySignedCurrentBindingCanWithdrawAnExactEventAndLateDeliveryCannotRestoreIt() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val registry = SecureStore(context); val original = registry.read()
        val origin = "https://withdrawal-${UUID.randomUUID()}.invalid"
        val store = SecureStore(context, origin); val mobile = DeviceCrypto(context, store)
        val sender = DeviceCrypto(context, SecureStore(context, "$origin/sender"))
        val pc = JSONObject(sender.publicDevice.toString()).put("deviceId", "pc_${UUID.randomUUID()}").put("kind", "pc")
        val pcId = pc.getString("deviceId"); val event = "evt_${UUID.randomUUID()}"
        val grant = JSONObject().put("relayOrigin", origin).put("bindingId", UUID.randomUUID().toString()).put("revision", 1)
            .put("pc", pc).put("mobile", mobile.publicDevice).put("scopes", JSONArray(listOf("events.read")))
        val binding = JSONObject().put("grant", grant).put("grantJws", sender.sign(grant, "binding-grant")).put("state", "active")
        val payload = JSONObject().put("protocolVersion", 1).put("relayOrigin", origin).put("mobileId", mobile.publicDevice.getString("deviceId"))
            .put("bindingId", grant.getString("bindingId")).put("bindingRevision", 1).put("pcId", pcId)
            .put("eventId", event).put("eventRevision", 2).put("pcSessionEpoch", UUID.randomUUID().toString())
            .put("kind", "completion").put("expiresAt", java.time.Instant.now().plusSeconds(120).toString())
            .put("notificationAction", "dismiss").put("preview", JSONObject().put("agent", "Codex").put("context", "").put("text", ""))
        val data = listOf("protocolVersion", "pcId", "eventId", "eventRevision", "pcSessionEpoch", "kind", "expiresAt", "notificationAction").associateWith { payload.get(it).toString() }
        val envelope = sender.seal(payload, mobile.publicDevice.getJSONObject("encryptionKey"), "notification-preview")
        val service = CompanionMessagingService()
        android.content.ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply { isAccessible = true }.invoke(service, context)
        fun deliver(value: Map<String, String>) = service.onMessageReceived(RemoteMessage.Builder("synthetic").setData(value).build())
        fun cards() = manager.activeNotifications.filter { it.tag?.startsWith("$pcId/") == true }
        fun awaitCount(count: Int) {
            val deadline = android.os.SystemClock.elapsedRealtime() + 5000
            while (cards().size != count && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
            assertEquals(count, cards().size)
        }
        val workKey = DeviceCrypto.sha256("$pcId/${data["pcSessionEpoch"]}/$event/2")
        try {
            registry.update { it.put("origins", JSONArray(listOf(origin))) }
            store.update { it.put("bindings", JSONArray(listOf(binding))) }
            val originalData = data - "notificationAction" + ("eventRevision" to "1")
            CompanionNotifications.show(context, originalData)
            CompanionNotifications.show(context, originalData + ("eventId" to "other-thread"))
            awaitCount(3)
            deliver(data) // No signed envelope.
            deliver(data + ("preview" to envelope) + ("eventId" to "other-thread"))
            deliver(data + ("preview" to envelope) - "notificationAction")
            assertEquals(3, cards().size)
            binding.put("state", "revoked"); store.update { it.put("bindings", JSONArray(listOf(binding))) }
            deliver(data + ("preview" to envelope)); assertEquals(3, cards().size)
            binding.put("state", "active"); store.update { it.put("bindings", JSONArray(listOf(binding))) }
            deliver(data + ("preview" to envelope)); awaitCount(2)
            assertTrue(cards().any { it.tag == "$pcId/other-thread" })
            assertEquals("suppressed_by_user", CompanionNotifications.show(context, originalData))
            deliver(data + ("preview" to envelope)); awaitCount(2)
            assertTrue(cards().none { it.tag == "$pcId/$event" })
        } finally {
            WorkManager.getInstance(context).cancelUniqueWork("vibe-halo-event-$workKey").result.get()
            CompanionNotifications.clearPc(context, pcId); registry.write(original)
        }
    }
}
