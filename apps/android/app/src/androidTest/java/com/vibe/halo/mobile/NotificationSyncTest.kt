package com.vibe.halo.mobile

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.google.firebase.messaging.RemoteMessage
import com.vibe.halo.mobile.data.*
import com.vibe.halo.mobile.notifications.CompanionMessagingService
import com.vibe.halo.mobile.security.DeviceCrypto
import com.vibe.halo.mobile.security.SecureStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

@RunWith(AndroidJUnit4::class)
class NotificationSyncTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun pushSchedulesReadOnlyFetchAndPersistsFullMessageWithoutOpeningActivity() = runBlocking {
        Fixture(context).use { fixture ->
            val repository = (context.applicationContext as VibeHaloApplication).repository
            repository.load(startDiscovery = false)
            val event = fixture.event(text = "## 完整正文\n这条内容比通知摘要更完整。")
            // The target is on a later page, and an unrelated event must not be cached.
            fixture.events = listOf(fixture.event(), event)
            val data = fixture.metadata(event)
            val key = DeviceCrypto.sha256("${data["pcId"]}/${data["pcSessionEpoch"]}/${data["eventId"]}/${data["eventRevision"]}")
            val workName = "vibe-halo-event-$key"
            try {
                // Call the actual FCM callback with a locally attached service.
                // This intentionally uses no Activity and no Firebase/network push.
                val service = CompanionMessagingService()
                android.content.ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply { isAccessible = true }.invoke(service, context)
                service.onMessageReceived(RemoteMessage.Builder("synthetic").setData(data).build())
                val deadline = android.os.SystemClock.elapsedRealtime() + 30000
                while (android.os.SystemClock.elapsedRealtime() < deadline && repository.state.value.events.none { it.summary.getString("eventId") == data["eventId"] }) delay(100)
                val cached = repository.state.value.events.single { it.summary.getString("eventId") == data["eventId"] }
                assertEquals(event.getJSONObject("detail").getString("toolInputText"), cached.detail.getString("toolInputText"))
                assertEquals(0L, cached.receivedElapsed)
                assertFalse(repository.actionable(cached))
                assertFalse(repository.state.value.computers.single().online)
                val restored = CompanionRepository(context)
                restored.load(startDiscovery = false)
                assertEquals(cached.detail.toString(), restored.state.value.events.single().detail.toString())
                assertTrue(fixture.paths.any { it.endsWith("offset=1") })
                assertTrue(fixture.paths.all { it in listOf("/v1/auth/challenge", "/v1/auth/session") || it.startsWith("/v1/pcs/${fixture.pcId}/events?") })
                val count = fixture.paths.size
                assertEquals(NotificationSyncResult.SYNCED, repository.syncNotification(fixture.target(event)))
                assertEquals("Duplicate delivery uses the already verified cache", count, fixture.paths.size)
                restored.close()
            } finally {
                WorkManager.getInstance(context).cancelUniqueWork(workName).result.get()
                repository.close()
            }
        }
    }

    @Test fun newerResolvedRevisionWinsAndOldPushCannotRestorePendingState() = runBlocking {
        Fixture(context).use { f ->
            val repo = CompanionRepository(context); repo.load(startDiscovery = false)
            val first = f.event(kind = "approval"); f.events = listOf(first)
            assertEquals(NotificationSyncResult.SYNCED, repo.syncNotification(f.target(first)))
            val second = f.event(id = first.getJSONObject("summary").getString("eventId"), revision = 2, kind = "approval", state = "resolved")
            f.events = listOf(second)
            assertEquals(NotificationSyncResult.SYNCED, repo.syncNotification(f.target(second)))
            val requests = f.paths.size
            assertEquals(NotificationSyncResult.SYNCED, repo.syncNotification(f.target(first)))
            assertEquals(requests, f.paths.size)
            val current = repo.state.value.events.single()
            assertEquals("resolved", current.summary.getString("state")); assertEquals(2L, current.summary.getLong("eventRevision"))
            assertFalse(repo.actionable(current)); assertEquals(0L, current.receivedElapsed)
            repo.close()
        }
    }

    @Test fun invalidSignatureWrongEpochAndRevokedBindingNeverPopulateCache() = runBlocking {
        Fixture(context).use { f ->
            val repo = CompanionRepository(context); repo.load(startDiscovery = false)
            val event = f.event(); f.events = listOf(JSONObject(event.toString()).put("envelope", "invalid"))
            assertEquals(NotificationSyncResult.RETRY, repo.syncNotification(f.target(event))); assertTrue(repo.state.value.events.isEmpty())
            f.events = listOf(event)
            assertEquals(NotificationSyncResult.RETRY, repo.syncNotification(f.target(event).copy(epoch = UUID.randomUUID().toString())))
            assertTrue(repo.state.value.events.isEmpty())
            f.status = 503
            assertEquals(NotificationSyncResult.RETRY, repo.syncNotification(f.target(event)))
            f.status = 403
            assertEquals(NotificationSyncResult.IGNORED, repo.syncNotification(f.target(event)))
            assertEquals("revoked", repo.state.value.computers.single().state)
            val count = f.paths.size
            assertEquals(NotificationSyncResult.IGNORED, repo.syncNotification(f.target(event)))
            assertEquals(count, f.paths.size); assertTrue(repo.state.value.events.isEmpty())
            repo.close()
        }
    }

    @Test fun backgroundLoadDoesNotChangeForegroundLifecycleOrFetchUnknownComputers() = runBlocking {
        Fixture(context).use { f ->
            val repo = CompanionRepository(context); repo.load()
            repo.load(startDiscovery = false)
            val foreground = repo.javaClass.getDeclaredField("foreground").apply { isAccessible = true }
            assertTrue(foreground.getBoolean(repo))
            assertEquals(NotificationSyncResult.IGNORED, repo.syncNotification(f.target(f.event()).copy(pcId = "pc_unknown")))
            assertTrue(f.paths.isEmpty()); repo.close(); assertFalse(foreground.getBoolean(repo))
        }
    }

    /** Self-contained synthetic relay. No real pairing, tokens, or external service. */
    private class Fixture(private val context: Context) : Closeable {
        private val registry = SecureStore(context)
        private val original = registry.read()
        private val server = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        private val origin = "http://127.0.0.1:${server.localPort}"
        private val store = SecureStore(context, origin)
        private val mobile = DeviceCrypto(context, store)
        private val sender = DeviceCrypto(context, SecureStore(context, "$origin/sender"))
        val pcId = "pc_${UUID.randomUUID()}"
        private val epoch = UUID.randomUUID().toString()
        private val binding = UUID.randomUUID().toString()
        val paths = CopyOnWriteArrayList<String>()
        @Volatile var events = emptyList<JSONObject>()
        @Volatile var status = 200

        init {
            val pc = JSONObject(sender.publicDevice.toString()).put("deviceId", pcId).put("kind", "pc")
            val grant = JSONObject().put("protocolVersion", 1).put("relayOrigin", origin).put("spaceId", "space_$pcId")
                .put("bindingId", binding).put("revision", 1).put("pc", pc).put("mobile", mobile.publicDevice)
                .put("lanTlsPin", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").put("scopes", JSONArray(listOf("events.read", "approvals.decide")))
            store.update { it.put("bindings", JSONArray(listOf(JSONObject().put("grant", grant).put("grantJws", sender.sign(grant, "binding-grant")).put("state", "active")))) }
            registry.update { it.put("origins", JSONArray(listOf(origin))) }
            thread(isDaemon = true, name = "notification-sync-test-relay") {
                while (!server.isClosed) runCatching { server.accept() }.getOrNull()?.use { socket ->
                    socket.soTimeout = 5000
                    val reader = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                    val path = reader.readLine().split(" ")[1]; paths += path
                    var length = 0
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
                    }
                    repeat(length) { reader.read() }
                    val code = if (path.contains("/events?")) status else 200
                    val value = when {
                        code != 200 -> JSONObject().put("error", "synthetic_failure")
                        path == "/v1/auth/challenge" -> JSONObject().put("challenge", JSONObject().put("protocolVersion", 1).put("relayOrigin", origin)
                            .put("purpose", "device-session").put("deviceId", mobile.publicDevice.getString("deviceId"))
                            .put("keyId", mobile.publicDevice.getJSONObject("signKey").getString("kid")).put("expiresAt", System.currentTimeMillis() + 60000).put("challengeId", "synthetic"))
                        path == "/v1/auth/session" -> JSONObject().put("token", "synthetic").put("expiresAt", System.currentTimeMillis() + 120000)
                        path.startsWith("/v1/pcs/$pcId/events?") -> {
                            val offset = path.substringAfter("offset=").toInt()
                            JSONObject().put("events", JSONArray(events.drop(offset).take(1).map { JSONObject(it.toString()).apply { remove("detail") } }))
                                .put("nextOffset", if (offset + 1 < events.size) offset + 1 else JSONObject.NULL).put("snapshotVersion", "synthetic").put("desktopOnline", true)
                        }
                        else -> error("Unexpected request: $path")
                    }
                    val bytes = value.toString().toByteArray()
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 $code Test\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(bytes); flush()
                    }
                }
            }
        }
        fun event(id: String = "event_${UUID.randomUUID()}", revision: Int = 1, kind: String = "completion", state: String = "resolved", text: String = "完整测试正文"): JSONObject {
            val summary = JSONObject().put("protocolVersion", 1).put("pcId", pcId).put("pcSessionEpoch", epoch).put("eventId", id)
                .put("eventRevision", revision).put("streamSeq", revision).put("kind", kind).put("agentId", "codex")
                .put("createdAt", CompanionRepository.iso(System.currentTimeMillis() - 1000)).put("expiresAt", CompanionRepository.iso(System.currentTimeMillis() + 120000))
                .put("state", if (kind == "approval" && revision == 1) "pending" else state).put("actionable", kind == "approval" && revision == 1)
                .put("pendingCount", 0).put("summaryKey", if (kind == "approval") "remote.approvalRequested" else "remote.completed")
            val detail = JSONObject().put("protocolVersion", 1).put("summary", summary).put("approvalId", id).put("approvalContextDigest", "sha256:" + "0".repeat(64))
                .put("toolName", "").put("toolInputText", text).put("description", "测试项目").put("options", JSONArray()).put("questions", JSONArray())
                .put("truncated", false).put("redacted", false).put("remoteActionable", kind == "approval").put("pcTime", CompanionRepository.iso(System.currentTimeMillis()))
            val message = JSONObject().put("protocolVersion", 1).put("type", "event.detail").put("relayOrigin", origin).put("pcId", pcId)
                .put("mobileId", mobile.publicDevice.getString("deviceId")).put("bindingId", binding).put("bindingRevision", 1).put("detail", detail)
            return JSONObject().put("summary", summary).put("detail", detail).put("envelope", sender.seal(message, mobile.publicDevice.getJSONObject("encryptionKey")))
        }
        fun metadata(event: JSONObject): Map<String, String> = listOf("protocolVersion", "pcId", "pcSessionEpoch", "eventId", "eventRevision", "kind", "agentId", "expiresAt")
            .associateWith { event.getJSONObject("summary").get(it).toString() }
        fun target(event: JSONObject) = NotificationSyncTarget.from(metadata(event))!!
        override fun close() { server.close(); registry.write(original) }
    }
}
