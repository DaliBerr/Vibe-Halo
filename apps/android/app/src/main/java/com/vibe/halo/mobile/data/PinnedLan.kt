package com.vibe.halo.mobile.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Base64
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

object PinnedLan {
    fun client(pin: String): OkHttpClient {
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = error("client_certificate_not_supported")
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val certificate = chain?.firstOrNull() ?: error("certificate_missing")
                certificate.checkValidity()
                val actual = MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)
                require(MessageDigest.isEqual(actual, Base64.decode(pin, Base64.NO_WRAP))) { "tls_pin_mismatch" }
            }
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust)
            // Only this per-binding client trusts the PC's pinned SPKI instead of DNS names.
            .hostnameVerifier { _, _ -> true }.connectTimeout(1500, TimeUnit.MILLISECONDS).readTimeout(3, TimeUnit.SECONDS)
            .callTimeout(4, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    }
}
class LanDiscovery(context: Context) {
    private val manager = context.getSystemService(NsdManager::class.java)
    private val found = ConcurrentHashMap<String, Pair<String, Long>>()
    private val serviceIds = ConcurrentHashMap<String, String>()
    private var listener: NsdManager.DiscoveryListener? = null
    fun endpoint(pcId: String): String? = found[pcId]?.takeIf { it.second > System.currentTimeMillis() }?.first
    fun reachable(pcId: String) { found.computeIfPresent(pcId) { _, value -> value.first to System.currentTimeMillis() + 120000 } }
    fun start() {
        if (listener != null) return
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { listener = null }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
            override fun onServiceLost(service: NsdServiceInfo) { serviceIds.remove(service.serviceName)?.let { found.remove(it) } }
            @Suppress("DEPRECATION") override fun onServiceFound(service: NsdServiceInfo) {
                if (!service.serviceType.contains("_vibe-halo._tcp")) return
                manager.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(service: NsdServiceInfo, code: Int) {}
                    override fun onServiceResolved(service: NsdServiceInfo) {
                        val pcId = service.attributes["pc"]?.toString(Charsets.UTF_8) ?: return
                        val address = service.host ?: return
                        if (!address.isSiteLocalAddress && !address.isLinkLocalAddress && !address.isLoopbackAddress) return
                        if (!Regex("pc_[A-Za-z0-9-]{1,80}").matches(pcId) || service.port !in 1..65535) return
                        val host = address.hostAddress ?: return
                        serviceIds[service.serviceName] = pcId
                        found[pcId] = "https://${if (host.contains(':')) "[${host.replace("%", "%25")}]" else host}:${service.port}" to System.currentTimeMillis() + 120000
                    }
                })
            }
        }
        listener = discovery
        runCatching { manager.discoverServices("_vibe-halo._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery) }.onFailure { listener = null }
    }
    fun stop() { listener?.let { runCatching { manager.stopServiceDiscovery(it) } }; listener = null; found.clear(); serviceIds.clear() }
}
