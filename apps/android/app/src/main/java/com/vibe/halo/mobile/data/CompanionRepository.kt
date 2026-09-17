package com.vibe.halo.mobile.data

import android.content.Context
import android.os.SystemClock
import com.vibe.halo.mobile.BuildConfig
import com.vibe.halo.mobile.security.DeviceCrypto
import com.vibe.halo.mobile.security.SecureStore
import com.vibe.halo.mobile.security.Wire
import com.vibe.halo.mobile.notifications.CompanionNotifications
import com.vibe.halo.mobile.security.Wire.Companion.values
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import java.util.concurrent.TimeUnit

data class Computer(val key: String, val origin: String, val grant: JSONObject, val state: String, val online: Boolean = false, val transport: String = "cloud", val profile: JSONObject? = null) {
    val pcId: String get() = grant.getJSONObject("pc").getString("deviceId")
    val name: String get() = profile?.optString("name") ?: grant.getJSONObject("pc").getString("name")
    val bindingId: String get() = grant.getString("bindingId")
    fun permits(scope: String) = grant.getJSONArray("scopes").values().contains(scope)
}
data class RemoteEvent(val key: String, val computerKey: String, val detail: JSONObject, val receivedElapsed: Long) {
    val summary: JSONObject get() = detail.getJSONObject("summary")
}
data class PairingView(val origin: String, val pairingId: String, val name: String, val fingerprint: String, val expiresAt: Long, val confirmedOnPc: Boolean = false)
data class HistoryItem(val computerKey: String, val record: JSONObject)
data class CompanionState(val computers: List<Computer> = emptyList(), val events: List<RemoteEvent> = emptyList(), val history: List<HistoryItem> = emptyList(), val historyDetails: Map<String, JSONObject> = emptyMap(), val pairing: PairingView? = null, val message: String = "", val busy: Boolean = false, val loaded: Boolean = false, val loadError: Boolean = false, val deviceName: String = "", val namePending: Boolean = false)
class ApiError(val code: String, val status: Int) : Exception(code)

class CompanionRepository(private val context: Context) {
    private val registry = SecureStore(context)
    private val accounts = java.util.concurrent.ConcurrentHashMap<String, Account>()
    private val mutex = Mutex()
    private val wire = Wire(context)
    private val mutable = MutableStateFlow(CompanionState())
    val state = mutable.asStateFlow()
    val updates = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private val pending = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
    private val clocks = java.util.concurrent.ConcurrentHashMap<String, PcClock>()
    private var pairingOffer: JSONObject? = null
    private var confirmedGrant: JSONObject? = null
    private var loaded = false
    @Volatile private var foreground = true
    private val cloud = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).callTimeout(12, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    val discovery = LanDiscovery(context)
    private class Account(val origin: String, val store: SecureStore, val crypto: DeviceCrypto) {
        var session: JSONObject? = null
        val sockets = java.util.concurrent.ConcurrentHashMap<String, WebSocket>()
        val lanSessions = mutableMapOf<String, JSONObject>()
    }
    private fun account(origin: String): Account = accounts.getOrPut(origin) {
        val store = SecureStore(context, origin); Account(origin, store, DeviceCrypto(context, store))
    }
    suspend fun load(startDiscovery: Boolean = true) = operation {
        foreground = startDiscovery
        if (loaded) { if (startDiscovery) discovery.start(); return@operation }
        mutable.value = mutable.value.copy(loadError = false, computers = emptyList(), events = emptyList())
        val saved = registry.read()
        for (raw in saved.optJSONArray("origins")?.values().orEmpty()) {
            val origin = checkedOrigin(raw as String); val account = account(origin); val data = account.store.read()
            val pcs = data.optJSONArray("bindings")?.values().orEmpty().map { rawBinding ->
                val item = rawBinding as JSONObject; val grant = item.getJSONObject("grant")
                verifyGrant(account, item.getString("grantJws"), grant)
                val profile = data.optJSONObject("peerProfiles")?.optString(grant.getJSONObject("pc").getString("deviceId"))?.let { signed -> runCatching { verifiedProfile(account, grant.getJSONObject("pc"), signed) }.getOrNull() }
                Computer("$origin/${grant.getString("bindingId")}", origin, grant, item.getString("state"), profile = profile)
            }
            val keys = pcs.filter { it.state == "active" }.map { it.key }.toSet()
            val events = data.optJSONArray("events")?.values().orEmpty().mapNotNull { rawEvent ->
                runCatching { val item = rawEvent as JSONObject; val detail = item.getJSONObject("detail"); wire.validate("event-detail", detail)
                    RemoteEvent(item.getString("key"), item.getString("computerKey"), detail, 0) }.getOrNull()
            }.filter { it.computerKey in keys }
            mutable.value = mutable.value.copy(computers = mutable.value.computers + pcs, events = mutable.value.events + events)
        }
        DeviceNames.migrate(context, accounts.values.firstOrNull()?.crypto?.publicDevice?.optString("name"))
        prune(); if (startDiscovery) discovery.start(); loaded = true
        mutable.value = mutable.value.copy(loaded = true, loadError = false, deviceName = DeviceNames.current(context))
    }.also { if (!loaded) mutable.value = mutable.value.copy(loadError = true) }
    suspend fun beginPairing(originText: String, codeText: String) = operation {
        val origin = checkedOrigin(originText.trim()); val account = account(origin)
        val code = codeText.replace(Regex("[\\s-]"), "").uppercase(); require(Regex("[A-Z0-9]{10,64}").matches(code)) { "invalid_code" }
        ensureProfile(account)
        val proof = fresh(origin).put("mobile", account.crypto.publicDevice).put("codeDigest", DeviceCrypto.sha256(code)).put("profile", account.store.read().getString("profileJws"))
        val result = request(account, "/v1/pairings/claim", "POST", JSONObject().put("code", code).put("mobile", account.crypto.publicDevice).put("proof", account.crypto.sign(proof, "pairing-claim")), false)
        val offerJws = result.getString("offer")
        // The offered root key is not trusted until the human compares this transcript on the PC.
        val untrusted = JSONObject(com.nimbusds.jose.JWSObject.parse(offerJws).payload.toString())
        val offer = DeviceCrypto.verify(offerJws, untrusted.getJSONObject("pc").getJSONObject("signKey"), "pairing-offer")
        require(offer.getInt("protocolVersion") == 1 && offer.getString("relayOrigin") == origin && offer.getString("pairingId") == result.getString("pairingId"))
        DeviceCrypto.checkedKey(offer.getJSONObject("pc").getJSONObject("encryptionKey"), "enc")
        val transcript = JSONObject().put("protocolVersion", 1).put("relayOrigin", origin).put("pairingId", offer.getString("pairingId"))
            .put("pc", offer.getJSONObject("pc")).put("mobile", account.crypto.publicDevice).put("lanTlsPin", offer.getString("lanTlsPin")).put("scopes", offer.getJSONArray("scopes"))
        pairingOffer = transcript; confirmedGrant = null
        val profile = offer.optString("profile").takeIf { it.isNotEmpty() }?.let { verifiedProfile(account, offer.getJSONObject("pc"), it) }
        mutable.value = mutable.value.copy(pairing = PairingView(origin, result.getString("pairingId"), profile?.getString("name") ?: offer.getJSONObject("pc").getString("name"), DeviceCrypto.fingerprint(transcript), result.getLong("expiresAt")), message = "请在电脑上核对指纹并确认。")
    }
    suspend fun pollPairing() = operation {
        val pairing = mutable.value.pairing ?: return@operation
        val account = account(pairing.origin)
        val proof = fresh(pairing.origin).put("pairingId", pairing.pairingId).put("mobileId", account.crypto.publicDevice.getString("deviceId"))
        val result = request(account, "/v1/pairings/${pairing.pairingId}/status", "POST", JSONObject().put("proof", account.crypto.sign(proof, "pairing-status")), false)
        when (result.getString("state")) {
            "active" -> {
                val offer = pairingOffer ?: error("pairing_missing")
                val grant = DeviceCrypto.verify(result.getString("grant"), offer.getJSONObject("pc").getJSONObject("signKey"), "binding-grant")
                for (key in offer.keys()) require(DeviceCrypto.canonical(offer.get(key)) == DeviceCrypto.canonical(grant.get(key))) { "pairing_mismatch" }
                verifyGrant(account, result.getString("grant"), grant)
                confirmedGrant = JSONObject().put("grant", grant).put("grantJws", result.getString("grant")).put("state", "active")
                mutable.value = mutable.value.copy(pairing = pairing.copy(confirmedOnPc = true), message = "电脑已确认。请再次核对两端指纹。")
            }
            "expired", "cancelled" -> { mutable.value = mutable.value.copy(pairing = null); error("pairing_expired") }
        }
    }
    suspend fun finishPairing() = operation {
        val pair = mutable.value.pairing ?: error("pairing_missing")
        val record = confirmedGrant ?: error("pc_confirmation_required")
        require(pair.confirmedOnPc)
        val account = account(pair.origin); val grant = record.getJSONObject("grant")
        val data = account.store.read(); val records = data.optJSONArray("bindings")?.values().orEmpty().filter { (it as JSONObject).getJSONObject("grant").getJSONObject("pc").getString("deviceId") != grant.getJSONObject("pc").getString("deviceId") }
        data.put("bindings", JSONArray(records + record)); account.store.write(data)
        registry.update { saved -> val origins = saved.optJSONArray("origins")?.values().orEmpty().map { it as String }; saved.put("origins", JSONArray((origins + pair.origin).distinct())) }
        val computer = Computer("${pair.origin}/${grant.getString("bindingId")}", pair.origin, grant, "active")
        mutable.value = mutable.value.copy(computers = mutable.value.computers.filterNot { it.origin == pair.origin && it.pcId == computer.pcId } + computer, pairing = null, message = "配对完成")
        pairingOffer = null; confirmedGrant = null
        runCatching { maintain(account) }
    }
    private fun verifyGrant(account: Account, jws: String, grant: JSONObject) {
        val verified = DeviceCrypto.verify(jws, grant.getJSONObject("pc").getJSONObject("signKey"), "binding-grant")
        require(DeviceCrypto.canonical(verified) == DeviceCrypto.canonical(grant))
        require(grant.getInt("protocolVersion") == 1 && grant.getString("relayOrigin") == account.origin)
        require(DeviceCrypto.canonical(grant.getJSONObject("mobile")) == DeviceCrypto.canonical(account.crypto.publicDevice))
        require(grant.getInt("revision") >= 1 && grant.getString("spaceId") == "space_${grant.getJSONObject("pc").getString("deviceId")}")
        require(Regex("[A-Za-z0-9+/]{43}=").matches(grant.getString("lanTlsPin")))
        require(grant.getJSONArray("scopes").values().all { it in setOf("events.read", "history.read", "approvals.decide", "questions.answer", "reminders.dismiss", "approvals.persistent") })
    }
    suspend fun refresh() = operation {
        accounts.values.forEach { runCatching { maintain(it) } }
        for (computer in mutable.value.computers.filter { it.state == "active" }) {
            val account = account(computer.origin)
            try {
                var online = false; var transport = "cloud"
                val snapshot = mutableListOf<JSONObject>()
                var consistent = false
                for (attempt in 0..2) {
                    snapshot.clear()
                    var offset: Int? = 0; var pages = 0; var version: String? = null; var changed = false
                    while (offset != null && pages++ < 500) {
                        val lan = runCatching { lanRequest(account, computer, "/v1/events?offset=$offset") }.getOrNull()
                        val result = lan ?: request(account, "/v1/pcs/${computer.pcId}/events?offset=$offset")
                        online = result.optBoolean("desktopOnline"); transport = if (lan != null) "lan" else "cloud"
                        val currentVersion = transport + ":" + result.getString("snapshotVersion")
                        if (version != null && version != currentVersion) { changed = true; break }
                        version = currentVersion
                        snapshot += result.getJSONArray("events").values().map { it as JSONObject }
                        require(snapshot.size <= 500)
                        val next = if (result.isNull("nextOffset")) null else result.getInt("nextOffset")
                        require(next == null || next > offset && next <= 500) { "invalid_cursor" }; offset = next
                    }
                    if (!changed && offset == null) { consistent = true; break }
                }
                require(consistent) { "refresh_required" }
                if (online && foreground) {
                    val started = SystemClock.elapsedRealtime()
                    val clock = readQuery(computer, "clock.read", JSONObject())
                    clocks[computer.key] = PcClock.sample(clock.getString("pcSessionEpoch"), clock.getLong("pcTime"), started, SystemClock.elapsedRealtime(), clocks[computer.key])
                } else clocks.remove(computer.key)
                val present = snapshot.map { "${computer.key}/${it.getJSONObject("summary").getString("eventId")}" }.toSet()
                mutable.value = mutable.value.copy(events = mutable.value.events.map { if (it.computerKey == computer.key && it.key !in present) it.copy(receivedElapsed = 0) else it })
                for (event in snapshot) {
                    consume(account, computer, event)
                    if (transport == "lan") notifyLan(account, computer, event.getJSONObject("summary"))
                }
                mutable.value = mutable.value.copy(computers = mutable.value.computers.map { if (it.key == computer.key) it.copy(online = online && foreground, transport = transport) else it })
                if (transport == "lan") subscribe(account, computer, true)
                runCatching { login(account); subscribe(account, computer) }
            } catch (error: Exception) {
                clocks.remove(computer.key)
                if (error is ApiError && error.status == 403) revokeLocally(computer)
                else mutable.value = mutable.value.copy(computers = mutable.value.computers.map { if (it.key == computer.key) it.copy(online = false) else it })
            }
        }
        prune(); persistEvents()
    }
    private fun consume(account: Account, computer: Computer, event: JSONObject) {
        val message = account.crypto.open(event.getString("envelope"), computer.grant.getJSONObject("pc").getJSONObject("signKey"))
        bound(message, computer, account, "event.detail")
        val detail = message.getJSONObject("detail"); wire.validate("event-detail", detail)
        require(DeviceCrypto.canonical(event.getJSONObject("summary")) == DeviceCrypto.canonical(detail.getJSONObject("summary")))
        val summary = detail.getJSONObject("summary"); require(summary.getString("pcId") == computer.pcId)
        if (summary.getString("state") != "pending" && summary.getString("kind") in listOf("approval", "question", "input")) CompanionNotifications.clearEvent(context, computer.pcId, summary.getString("eventId"), summary.getLong("eventRevision"))
        val key = "${computer.key}/${summary.getString("eventId")}"
        val previous = mutable.value.events.find { it.key == key }
        if (previous != null) {
            require(previous.summary.getString("pcSessionEpoch") == summary.getString("pcSessionEpoch"))
            if (previous.summary.getLong("eventRevision") > summary.getLong("eventRevision")) return
            if (previous.summary.getString("state") != "pending" && summary.getString("state") == "pending") return
        }
        val received = SystemClock.elapsedRealtime()
        val value = RemoteEvent(key, computer.key, detail, received)
        mutable.value = mutable.value.copy(events = mutable.value.events.filterNot { it.key == key } + value)
    }
    fun actionable(event: RemoteEvent): Boolean {
        if (pending.containsKey(event.key)) return false
        val pc = mutable.value.computers.find { it.key == event.computerKey } ?: return false
        if (!pc.permits(if (event.summary.optString("kind") == "question") "questions.answer" else "approvals.decide")) return false
        if (!pc.online || pc.state != "active" || !event.detail.optBoolean("remoteActionable") || !event.summary.optBoolean("actionable") || event.receivedElapsed <= 0) return false
        val pcNow = eventPcTime(event) ?: return false
        return event.summary.getString("state") == "pending" && pcNow < Instant.parse(event.summary.getString("expiresAt")).toEpochMilli()
    }
    fun hasPendingDecision(eventKey: String): Boolean = pending.containsKey(eventKey)
    private fun eventPcTime(event: RemoteEvent): Long? = clocks[event.computerKey]?.now(event.summary.getString("pcSessionEpoch"), SystemClock.elapsedRealtime())
    fun remainingSeconds(event: RemoteEvent): Long? = runCatching {
        if (event.receivedElapsed <= 0) return null
        val now = eventPcTime(event) ?: return null
        ((Instant.parse(event.summary.getString("expiresAt")).toEpochMilli() - now).coerceAtLeast(0) + 999) / 1000
    }.getOrNull()
    suspend fun decide(eventKey: String, optionId: String, answers: JSONObject? = null, persistentConfirmed: Boolean = false) = operation {
        val event = mutable.value.events.find { it.key == eventKey } ?: error("not_found")
        val computer = mutable.value.computers.first { it.key == event.computerKey }
        require(actionable(event)) { "refresh_required" }
        val detail = event.detail; val summary = event.summary
        require(detail.getJSONArray("options").values().any { (it as JSONObject).getString("id") == optionId }) { "invalid_action" }
        require(computer.permits(if (optionId == "submit") "questions.answer" else "approvals.decide")) { "forbidden" }
        val persistent = optionId == "always" || optionId.startsWith("suggestion:")
        if (persistent) require(persistentConfirmed && computer.permits("approvals.persistent") && detail.optJSONObject("persistentPreviews")?.optString(optionId)?.isNotEmpty() == true) { "persistent_not_available" }
        val now = eventPcTime(event) ?: error("clock_refresh_required")
        val intent = JSONObject().put("protocolVersion", 1).put("decisionId", UUID.randomUUID().toString()).put("pcId", computer.pcId)
            .put("mobileId", computer.grant.getJSONObject("mobile").getString("deviceId")).put("bindingId", computer.bindingId).put("bindingRevision", computer.grant.getInt("revision"))
            .put("pcSessionEpoch", summary.getString("pcSessionEpoch")).put("eventId", summary.getString("eventId")).put("approvalId", detail.getString("approvalId"))
            .put("expectedRevision", summary.getLong("eventRevision")).put("approvalContextDigest", detail.getString("approvalContextDigest"))
            .put("optionId", optionId).put("issuedAt", iso(now)).put("expiresAt", iso(minOf(now + 30000, Instant.parse(summary.getString("expiresAt")).toEpochMilli())))
        if (answers != null) intent.put("answers", answers)
        if (persistent) intent.put("persistentConfirmed", true)
        wire.validate("decision-intent", intent)
        val account = account(computer.origin)
        val payload = JSONObject().put("decisionId", intent.getString("decisionId")).put("envelope", account.crypto.seal(intent, computer.grant.getJSONObject("pc").getJSONObject("encryptionKey"), "decision-intent"))
        pending[eventKey] = payload
        if (pending.size > 100) { pending.remove(eventKey); error("capacity_exceeded") }
        submit(account, computer, eventKey, payload)
    }
    suspend fun retryDecision(eventKey: String) = operation {
        val event = mutable.value.events.find { it.key == eventKey } ?: error("not_found")
        val computer = mutable.value.computers.first { it.key == event.computerKey }
        submit(account(computer.origin), computer, eventKey, pending[eventKey] ?: error("no_pending_decision"))
    }
    private fun submit(account: Account, computer: Computer, eventKey: String, payload: JSONObject) {
        val result = runCatching { lanRequest(account, computer, "/v1/decisions", "POST", payload) }.getOrNull()
            ?: request(account, "/v1/pcs/${computer.pcId}/decisions", "POST", payload)
        if (result.optString("state") == "desktop_result") applyReceipt(account, computer, result, payload.getString("decisionId"), eventKey)
        else mutable.value = mutable.value.copy(message = if (result.optString("state") == "desktop_offline") "电脑离线，尚未执行。可用相同请求重试。" else "已送达中继，等待电脑回执。")
    }
    suspend fun checkReceipts() = operation {
        for ((eventKey, payload) in pending.toMap()) {
            val event = mutable.value.events.find { it.key == eventKey } ?: continue
            val computer = mutable.value.computers.find { it.key == event.computerKey && it.state == "active" } ?: continue
            val account = account(computer.origin)
            runCatching {
                val result = request(account, "/v1/pcs/${computer.pcId}/decisions/${payload.getString("decisionId")}")
                if (result.optString("state") == "desktop_result") applyReceipt(account, computer, result, payload.getString("decisionId"), eventKey)
            }
        }
    }
    private fun applyReceipt(account: Account, computer: Computer, result: JSONObject, decisionId: String, eventKey: String) {
        val receipt = account.crypto.open(result.getString("envelope"), computer.grant.getJSONObject("pc").getJSONObject("signKey"), "decision-receipt")
        bound(receipt, computer, account, "decision.receipt"); require(receipt.getString("decisionId") == decisionId)
        pending.remove(eventKey)
        mutable.value = mutable.value.copy(message = when (receipt.getString("status")) {
            "desktop_accepted" -> "电脑已接受决定；客户端是否执行仍以客户端为准。"
            "expired" -> "请求已过期，请回到客户端处理。"
            "forbidden" -> "电脑未开启远程控制，或当前设备没有这项权限。"
            "stale_revision", "stale_context", "not_current", "stale_epoch" -> "请求已变化，请刷新后重新查看。"
            else -> "电脑回执：${receipt.getString("status")}"
        })
    }
    private fun bound(message: JSONObject, pc: Computer, account: Account, type: String) {
        Wire.safe(message)
        require(message.getInt("protocolVersion") == 1 && message.getString("type") == type && message.getString("relayOrigin") == account.origin)
        require(message.getString("pcId") == pc.pcId && message.getString("mobileId") == account.crypto.publicDevice.getString("deviceId"))
        require(message.getString("bindingId") == pc.bindingId && message.getInt("bindingRevision") == pc.grant.getInt("revision"))
    }
    suspend fun revoke(computerKey: String) = operation {
        val computer = mutable.value.computers.first { it.key == computerKey }
        val account = account(computer.origin)
        account.store.update { it.put("pendingRevocations", JSONArray(it.optJSONArray("pendingRevocations")?.values().orEmpty() + computer.bindingId)) }
        revokeLocally(computer)
        val synced = runCatching { maintain(account) }.isSuccess
        mutable.value = mutable.value.copy(message = if (synced) "云端已撤销。电脑收到撤销后，局域网权限也会关闭；离线电脑可能尚未确认。" else "本机已移除权限。云端撤销将在恢复连接后重试，离线电脑可能尚未确认。")
    }
    private fun revokeLocally(computer: Computer) {
        CompanionNotifications.clearPc(context, computer.pcId)
        val account = account(computer.origin); account.lanSessions.remove(computer.key); account.sockets.remove(computer.key)?.close(1000, "revoked"); account.sockets.remove(computer.key + "/lan")?.close(1000, "revoked")
        pending.keys.removeIf { it.startsWith(computer.key + "/") }
        mutable.value = mutable.value.copy(computers = mutable.value.computers.map { if (it.key == computer.key) it.copy(state = "revoked", online = false) else it }, events = mutable.value.events.filterNot { it.computerKey == computer.key }, history = mutable.value.history.filterNot { it.computerKey == computer.key }, historyDetails = mutable.value.historyDetails.filterKeys { !it.startsWith(computer.key + "/") })
        val data = account.store.read(); data.optJSONArray("bindings")?.values()?.forEach { val item = it as JSONObject; if (item.getJSONObject("grant").getString("bindingId") == computer.bindingId) item.put("state", "revoked") }; account.store.write(data)
        persistEvents()
    }
    suspend fun notificationPreferences(key: String, enabled: Boolean) = operation {
        val computer = mutable.value.computers.first { it.key == key }
        context.getSharedPreferences("notification-preferences", Context.MODE_PRIVATE).edit().putBoolean("${computer.pcId}:muted", !enabled).apply()
        val account = account(computer.origin)
        account.store.update { saved -> val prefs = saved.optJSONObject("pendingPreferences") ?: JSONObject(); prefs.put(computer.pcId, JSONObject().put("enabled", enabled).put("approvals", true).put("questions", true).put("completions", true).put("revision", System.currentTimeMillis())); saved.put("pendingPreferences", prefs) }
        val synced = runCatching { maintain(account) }.isSuccess
        mutable.value = mutable.value.copy(message = if (!synced) "本机偏好已保存，云端将在恢复连接后同步。" else if (enabled) "已开启这台电脑的提醒" else "已关闭这台电脑的提醒")
    }
    suspend fun loadHistory(computerKey: String) = operation {
        val pc = mutable.value.computers.first { it.key == computerKey && it.state == "active" }
        require(pc.permits("history.read")) { "forbidden" }
        var offset: Int? = 0; val items = mutableListOf<HistoryItem>()
        while (offset != null && items.size < 200) {
            val response = readQuery(pc, "history.list", JSONObject().put("offset", offset).put("viewVersion", 2))
            val records = response.getJSONArray("records"); require(records.length() <= 25)
            items += records.values().map { HistoryItem(pc.key, it as JSONObject) }
            val next = if (response.isNull("nextOffset")) null else response.getInt("nextOffset")
            require(next == null || next > offset && next <= 200); offset = next
        }
        mutable.value = mutable.value.copy(history = mutable.value.history.filterNot { it.computerKey == pc.key } + items, message = "已读取电脑历史")
    }
    suspend fun dismissReminder(eventKey: String) = operation {
        val event = mutable.value.events.first { it.key == eventKey }
        val pc = mutable.value.computers.first { it.key == event.computerKey && it.state == "active" }
        require(pc.online && pc.permits("reminders.dismiss") && event.summary.getString("kind") == "input") { "forbidden" }
        readQuery(pc, "reminder.dismiss", JSONObject().put("eventId", event.summary.getString("eventId")).put("pcSessionEpoch", event.summary.getString("pcSessionEpoch")).put("eventRevision", event.summary.getLong("eventRevision")))
        mutable.value = mutable.value.copy(message = "已关闭提醒，客户端仍等待你输入。")
    }
    suspend fun loadHistoryDetail(computerKey: String, historyId: String) = operation {
        val pc = mutable.value.computers.first { it.key == computerKey && it.state == "active" }
        require(pc.permits("history.read")) { "forbidden" }
        val response = readQuery(pc, "history.detail", JSONObject().put("historyId", historyId).put("viewVersion", 2))
        val record = response.getJSONArray("records").optJSONObject(0) ?: error("not_found")
        require(record.toString().toByteArray().size <= 60000)
        val readable = HistoryPresentation.detail(record, mutable.value.history.find { it.computerKey == computerKey && it.record.optString("id") == historyId }?.record)
        val details = mutable.value.historyDetails.toMutableMap(); details["$computerKey/$historyId"] = readable
        while (details.size > 200 || details.values.sumOf { it.toString().toByteArray().size } > 4 * 1024 * 1024) details.remove(details.keys.first())
        mutable.value = mutable.value.copy(historyDetails = details)
    }
    private fun readQuery(pc: Computer, type: String, fields: JSONObject): JSONObject {
        val account = account(pc.origin); val requestId = UUID.randomUUID().toString()
        val query = fresh(pc.origin).put("type", type).put("requestId", requestId).put("pcId", pc.pcId).put("mobileId", account.crypto.publicDevice.getString("deviceId"))
            .put("bindingId", pc.bindingId).put("bindingRevision", pc.grant.getInt("revision"))
        if (type != "clock.read") clocks[pc.key]?.let { clock -> clock.now(clock.epoch, SystemClock.elapsedRealtime())?.let { query.put("issuedAt", it) } }
        for (key in fields.keys()) query.put(key, fields.get(key))
        val payload = JSONObject().put("requestId", requestId).put("envelope", account.crypto.seal(query, pc.grant.getJSONObject("pc").getJSONObject("encryptionKey"), "read-request"))
        var response = runCatching { lanRequest(account, pc, "/v1/queries", "POST", payload) }.getOrNull()
            ?: request(account, "/v1/pcs/${pc.pcId}/queries", "POST", payload)
        var attempts = 0
        while (response.optString("state") != "desktop_result" && response.optString("state") != "desktop_offline" && attempts++ < 8) {
            Thread.sleep(250); response = request(account, "/v1/pcs/${pc.pcId}/queries/$requestId")
        }
        require(response.optString("state") == "desktop_result") { "desktop_offline" }
        val value = account.crypto.open(response.getString("envelope"), pc.grant.getJSONObject("pc").getJSONObject("signKey"), "read-response")
        bound(value, pc, account, if (type == "clock.read") "clock.response" else "history.response"); require(value.getString("requestId") == requestId)
        return value
    }
    suspend fun registerPushToken(token: String) = operation {
        require(token.length in 20..4096)
        registry.update { it.put("pushToken", token) }
        for (account in accounts.values) runCatching { maintain(account) }
    }
    private fun verifiedProfile(account: Account, device: JSONObject, signed: String): JSONObject =
        DeviceNames.profile(DeviceCrypto.verify(signed, device.getJSONObject("signKey"), "device-profile"), device.getString("deviceId"), account.origin)
    private fun ensureProfile(account: Account) {
        val saved = account.store.read(); val name = DeviceNames.current(context)
        if (saved.optJSONObject("profile")?.optString("name") == name) return
        val profile = JSONObject().put("protocolVersion", 1).put("deviceId", account.crypto.publicDevice.getString("deviceId"))
            .put("relayOrigin", account.origin).put("name", name).put("revision", maxOf(System.currentTimeMillis(), (saved.optJSONObject("profile")?.optLong("revision") ?: 0) + 1))
        account.store.update { it.put("profile", profile).put("profileJws", account.crypto.sign(profile, "device-profile")).put("profilePending", true) }
    }
    private fun syncProfile(account: Account) {
        ensureProfile(account)
        if (mutable.value.computers.none { it.origin == account.origin && it.state == "active" }) return
        val saved = account.store.read()
        if (saved.optBoolean("profilePending")) {
            request(account, "/v1/device-profile", "PUT", JSONObject().put("profile", saved.getString("profileJws")))
            account.store.update { it.put("profilePending", false) }
        }
        val bindings = request(account, "/v1/devices").getJSONArray("bindings")
        require(bindings.length() <= 64)
        for (raw in bindings.values()) {
            val row = raw as JSONObject
            val pc = mutable.value.computers.find { it.origin == account.origin && it.bindingId == row.optString("id") && it.state == "active" } ?: continue
            val signed = row.optString("pc_profile").takeUnless { it.isBlank() || it == "null" } ?: continue
            runCatching {
                val profile = verifiedProfile(account, pc.grant.getJSONObject("pc"), signed)
                if (profile.getLong("revision") > (pc.profile?.optLong("revision") ?: 0)) {
                    account.store.update { val peers = it.optJSONObject("peerProfiles") ?: JSONObject(); peers.put(pc.pcId, signed); it.put("peerProfiles", peers) }
                    mutable.value = mutable.value.copy(computers = mutable.value.computers.map { if (it.key == pc.key) it.copy(profile = profile) else it })
                }
            }
        }
    }
    suspend fun renameDevice(name: String?) = operation {
        DeviceNames.set(context, name)
        accounts.values.forEach { ensureProfile(it) }
        mutable.value = mutable.value.copy(deviceName = DeviceNames.current(context), namePending = accounts.isNotEmpty())
        accounts.values.forEach { runCatching { syncProfile(it) } }
        updateNameState()
    }
    private fun updateNameState() {
        mutable.value = mutable.value.copy(deviceName = DeviceNames.current(context), namePending = accounts.values.any { account -> mutable.value.computers.any { it.origin == account.origin && it.state == "active" } && account.store.read().optBoolean("profilePending") })
    }
    private fun maintain(account: Account) {
        runCatching { syncProfile(account) }
        updateNameState()
        val saved = account.store.read()
        for (id in saved.optJSONArray("pendingRevocations")?.values().orEmpty()) {
            try { request(account, "/v1/bindings/$id", "DELETE") } catch (error: ApiError) { if (error.status !in listOf(403, 404)) throw error }
            account.store.update { it.put("pendingRevocations", JSONArray(it.optJSONArray("pendingRevocations")?.values().orEmpty().filterNot { value -> value == id })) }
        }
        if (mutable.value.computers.none { it.origin == account.origin && it.state == "active" }) return
        val locale = com.vibe.halo.mobile.UiLanguage.resolvedLocale()
        val activePcs = mutable.value.computers.filter { it.origin == account.origin && it.state == "active" }
        if (activePcs.any { saved.optJSONObject("notificationLocales")?.optString(it.pcId) != locale || saved.optJSONObject("pendingPreferences")?.has(it.pcId) == true }) account.store.update { latest ->
            val pending = latest.optJSONObject("pendingPreferences") ?: JSONObject()
            val syncedLocales = latest.optJSONObject("notificationLocales") ?: JSONObject()
            val revisions = latest.optJSONObject("notificationPreferenceRevisions") ?: JSONObject()
            for (pc in activePcs) {
                if (syncedLocales.optString(pc.pcId) != locale || pending.has(pc.pcId)) {
                    val pref = pending.optJSONObject(pc.pcId) ?: JSONObject()
                        .put("enabled", !context.getSharedPreferences("notification-preferences", Context.MODE_PRIVATE).getBoolean("${pc.pcId}:muted", false))
                        .put("approvals", true).put("questions", true).put("completions", true)
                    val revision = maxOf(System.currentTimeMillis(), revisions.optLong(pc.pcId) + 1, pref.optLong("revision") + 1)
                    pref.put("locale", locale).put("revision", revision)
                    pending.put(pc.pcId, pref); revisions.put(pc.pcId, revision)
                }
            }
            latest.put("pendingPreferences", pending).put("notificationPreferenceRevisions", revisions)
        }
        val prefs = account.store.read().optJSONObject("pendingPreferences") ?: JSONObject()
        for (pcId in prefs.keys()) {
            try { request(account, "/v1/pcs/$pcId/notification-preferences", "PUT", prefs.getJSONObject(pcId)) } catch (error: ApiError) { if (error.status != 403) throw error }
            account.store.update {
                it.optJSONObject("pendingPreferences")?.remove(pcId)
                val locales = it.optJSONObject("notificationLocales") ?: JSONObject()
                locales.put(pcId, locale); it.put("notificationLocales", locales)
            }
        }
        val token = registry.read().optString("pushToken")
        if (token.isNotEmpty() && saved.optString("registeredPushDigest") != DeviceCrypto.sha256(token)) {
            request(account, "/v1/push-token", "PUT", JSONObject().put("token", token).put("revision", System.currentTimeMillis()))
            account.store.update { it.put("registeredPushDigest", DeviceCrypto.sha256(token)) }
        }
    }
    suspend fun syncMaintenance(): Boolean = withContext(Dispatchers.IO) { mutex.withLock {
        var success = true
        accounts.values.forEach { if (runCatching { maintain(it) }.isFailure) success = false }
        success
    } }
    private fun prune() {
        val events = mutable.value.events.filter { Instant.parse(it.summary.getString("createdAt")).toEpochMilli() > System.currentTimeMillis() - 86400000 }
            .sortedByDescending { it.summary.getString("createdAt") }.take(500).toMutableList()
        var bytes = events.sumOf { it.detail.toString().toByteArray().size }
        while (bytes > 10 * 1024 * 1024 && events.isNotEmpty()) bytes -= events.removeAt(events.lastIndex).detail.toString().toByteArray().size
        mutable.value = mutable.value.copy(events = events)
    }
    private fun persistEvents() {
        for (account in accounts.values) {
            val keys = mutable.value.computers.filter { it.origin == account.origin }.map { it.key }.toSet()
            val events = mutable.value.events.filter { it.computerKey in keys }.map { JSONObject().put("key", it.key).put("computerKey", it.computerKey).put("detail", it.detail) }
            val data = account.store.read(); data.put("events", JSONArray(events)); account.store.write(data)
        }
    }
    private fun login(account: Account) {
        if ((account.session?.optLong("expiresAt") ?: 0) > System.currentTimeMillis() + 30000) return
        val challenge = request(account, "/v1/auth/challenge", "POST", JSONObject().put("deviceId", account.crypto.publicDevice.getString("deviceId")), false).getJSONObject("challenge")
        require(challenge.getInt("protocolVersion") == 1 && challenge.getString("relayOrigin") == account.origin && challenge.getString("purpose") == "device-session")
        require(challenge.getString("deviceId") == account.crypto.publicDevice.getString("deviceId") && challenge.getString("keyId") == account.crypto.publicDevice.getJSONObject("signKey").getString("kid"))
        require(challenge.getLong("expiresAt") > System.currentTimeMillis() && challenge.getLong("expiresAt") < System.currentTimeMillis() + 120000)
        account.session = request(account, "/v1/auth/session", "POST", JSONObject().put("challengeId", challenge.getString("challengeId")).put("proof", account.crypto.sign(challenge, "device-session")), false)
    }
    private fun notifyLan(account: Account, pc: Computer, summary: JSONObject) {
        if (summary.getString("kind") in listOf("completion", "plan") && Instant.parse(summary.getString("createdAt")).toEpochMilli() < System.currentTimeMillis() - 600000) return
        if (Instant.parse(summary.getString("expiresAt")).toEpochMilli() <= System.currentTimeMillis()) return
        if (summary.getString("kind") in listOf("approval", "question") && !summary.getBoolean("actionable")) return
        if (summary.getString("kind") == "input" && summary.getString("state") != "pending") return
        val data = listOf("protocolVersion", "pcId", "pcSessionEpoch", "eventId", "eventRevision", "kind").associateWith { summary.get(it).toString() }
        val status = CompanionNotifications.show(context, data)
        if (status !in listOf("notification_posted", "suppressed_by_user")) return
        val ack = JSONObject().put("protocolVersion", 1).put("pcId", pc.pcId).put("mobileId", account.crypto.publicDevice.getString("deviceId"))
            .put("bindingId", pc.bindingId).put("bindingRevision", pc.grant.getInt("revision")).put("pcSessionEpoch", summary.getString("pcSessionEpoch"))
            .put("eventId", summary.getString("eventId")).put("eventRevision", summary.getLong("eventRevision")).put("status", status)
        runCatching { lanRequest(account, pc, "/v1/notification-ack", "POST", JSONObject().put("envelope", account.crypto.seal(ack, pc.grant.getJSONObject("pc").getJSONObject("encryptionKey"), "notification-ack"))) }
    }
    private fun subscribe(account: Account, pc: Computer, lan: Boolean = false) {
        if (!foreground) return
        val key = pc.key + if (lan) "/lan" else ""
        val session = (if (lan) account.lanSessions[pc.key] else account.session) ?: return
        if (account.sockets.containsKey(key) || session.optLong("expiresAt") <= System.currentTimeMillis()) return
        val url = if (lan) session.getString("endpoint").replaceFirst("https", "wss") + "/v1/stream" else account.origin.replaceFirst("http", "ws") + "/v1/pcs/${pc.pcId}/stream"
        val request = Request.Builder().url(url).header("Authorization", "Bearer ${session.getString("token")}").build()
        val socket = (if (lan) PinnedLan.client(pc.grant.getString("lanTlsPin")) else cloud).newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.toByteArray().size > 16384) { webSocket.close(1009, "too_large"); return }
                runCatching {
                    val value = JSONObject(text); Wire.safe(value)
                    if (value.optString("type") in listOf("events.changed", "decision.result", "bindings.changed", "profiles.changed")) updates.tryEmit(Unit)
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { account.sockets.remove(key, webSocket) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { account.sockets.remove(key, webSocket) }
        })
        account.sockets[key] = socket
    }
    private fun request(account: Account, path: String, method: String = "GET", data: JSONObject? = null, auth: Boolean = true, retry: Boolean = true): JSONObject {
        if (auth) login(account)
        try { return http(cloud, account.origin + path, method, data, if (auth) account.session!!.getString("token") else null) }
        catch (error: ApiError) { if (error.status == 401 && auth && retry) { account.session = null; return request(account, path, method, data, auth, false) }; throw error }
    }
    private fun lanRequest(account: Account, pc: Computer, path: String, method: String = "GET", data: JSONObject? = null): JSONObject {
        val endpoint = discovery.endpoint(pc.pcId) ?: error("lan_unavailable")
        val client = PinnedLan.client(pc.grant.getString("lanTlsPin"))
        var session = account.lanSessions[pc.key]
        if (session == null || session.getLong("expiresAt") < System.currentTimeMillis() + 10000 || session.getString("endpoint") != endpoint) {
            account.sockets.remove(pc.key + "/lan")?.close(1000, "renew_session")
            val challenge = http(client, "$endpoint/v1/auth/challenge", "POST", JSONObject().put("bindingId", pc.bindingId).put("mobileId", account.crypto.publicDevice.getString("deviceId"))).getJSONObject("challenge")
            require(challenge.getString("pcId") == pc.pcId && challenge.getString("bindingId") == pc.bindingId && challenge.getString("mobileId") == account.crypto.publicDevice.getString("deviceId"))
            require(challenge.getInt("bindingRevision") == pc.grant.getInt("revision") && challenge.getString("tlsPin") == pc.grant.getString("lanTlsPin"))
            require(challenge.getInt("protocolVersion") == 1 && challenge.getString("relayOrigin") == account.origin && challenge.getString("purpose") == "lan-session" && challenge.getLong("expiresAt") > System.currentTimeMillis())
            session = http(client, "$endpoint/v1/auth/session", "POST", JSONObject().put("challengeId", challenge.getString("challengeId")).put("proof", account.crypto.sign(challenge, "lan-session"))).put("endpoint", endpoint)
            account.lanSessions[pc.key] = session
        }
        val result = try { http(client, endpoint + path, method, data, session.getString("token")) }
            catch (error: Exception) { account.lanSessions.remove(pc.key); account.sockets.remove(pc.key + "/lan")?.close(1000, "reconnect"); throw error }
        discovery.reachable(pc.pcId)
        return result
    }
    private fun http(client: OkHttpClient, url: String, method: String, data: JSONObject?, token: String? = null): JSONObject {
        val builder = Request.Builder().url(url)
        if (token != null) builder.header("Authorization", "Bearer $token")
        builder.method(method, if (method in listOf("GET", "DELETE")) null else (data ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            val stream = response.body.byteStream(); val bytes = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
            while (true) { val count = stream.read(buffer); if (count < 0) break; require(bytes.size() + count <= 262144) { "too_large" }; bytes.write(buffer, 0, count) }
            val value = JSONObject(bytes.toString("UTF-8")); Wire.safe(value)
            if (!response.isSuccessful) throw ApiError(value.optString("error", "request_failed"), response.code)
            return value
        }
    }
    private suspend fun operation(block: () -> Unit) = withContext(Dispatchers.IO) { mutex.withLock {
        mutable.value = mutable.value.copy(busy = true)
        try { block() } catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error
            android.util.Log.w("VibeHalo", "operation_failed:${error.javaClass.simpleName}:${(error as? ApiError)?.code.orEmpty()}:" + error.stackTrace.take(4).joinToString { "${it.className}.${it.methodName}:${it.lineNumber}" })
            mutable.value = mutable.value.copy(message = when ((error as? ApiError)?.code ?: error.message) {
            "invalid_code" -> "配对码无效或已经使用，请在电脑上生成新配对码。"
            "pairing_expired" -> "配对已过期，请重新配对。"
            "refresh_required" -> "当前详情已失效或电脑离线，请先刷新。"
            "forbidden" -> "设备权限已撤销，或没有这项操作权限。"
            else -> "操作未完成，请检查连接后重试。"
        }) } finally { mutable.value = mutable.value.copy(busy = false) }
    } }
    fun resume() { foreground = true; discovery.start() }
    fun close() {
        clocks.clear()
        foreground = false
        mutable.value = mutable.value.copy(computers = mutable.value.computers.map { it.copy(online = false) }, events = mutable.value.events.map { it.copy(receivedElapsed = 0) })
        discovery.stop(); accounts.values.toList().forEach { account -> account.sockets.values.forEach { socket -> socket.close(1000, "background") }; account.sockets.clear() }
    }
    companion object {
        private val formatter = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
        fun iso(millis: Long): String = formatter.format(Instant.ofEpochMilli(millis))
        fun checkedOrigin(value: String): String {
            val uri = URI(value)
            require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.path in listOf("", "/"))
            require(uri.host != null && (uri.scheme == "https" || BuildConfig.DEBUG && uri.scheme == "http" && uri.host in listOf("127.0.0.1", "localhost", "10.0.2.2")))
            return "${uri.scheme}://${uri.rawAuthority}"
        }
        private fun fresh(origin: String) = JSONObject().put("protocolVersion", 1).put("relayOrigin", origin).put("issuedAt", System.currentTimeMillis())
    }
}
