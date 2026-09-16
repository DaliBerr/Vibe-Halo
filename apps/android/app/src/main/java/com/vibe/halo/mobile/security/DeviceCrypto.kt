package com.vibe.halo.mobile.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.nimbusds.jose.*
import com.nimbusds.jose.crypto.*
import com.nimbusds.jose.jwk.Curve
import com.nimbusds.jose.jwk.ECKey
import com.nimbusds.jose.jwk.KeyUse
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.UUID

class DeviceCrypto(context: Context, private val store: SecureStore) {
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val alias = "vibe-halo-device-sign-v1" + if (store.namespace == "default") "" else "-${sha256(store.namespace).take(24)}"
    private val signPrivate: PrivateKey
    private val encryptionPrivate: PrivateKey
    val publicDevice: JSONObject

    init { synchronized(IDENTITY_LOCK) {
        val saved = store.read()
        if (saved.has("identity")) {
            require(keyStore.containsAlias(alias)) { "identity_lost_repair_required" }
            publicDevice = saved.getJSONObject("identity")
            signPrivate = keyStore.getKey(alias, null) as PrivateKey
            encryptionPrivate = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.decode(saved.getString("encryptionPrivate"), Base64.NO_WRAP)))
            val certificate = keyStore.getCertificate(alias).publicKey as ECPublicKey
            require(ECKey.Builder(Curve.P_256, certificate).build().computeThumbprint().toString() == publicDevice.getJSONObject("signKey").getString("kid").removePrefix("sig:"))
        } else {
            if (!keyStore.containsAlias(alias)) {
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                    initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
                }.generateKeyPair()
            }
            signPrivate = keyStore.getKey(alias, null) as PrivateKey
            val encryption = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            encryptionPrivate = encryption.private
            val signing = publicJwk(keyStore.getCertificate(alias).publicKey as ECPublicKey, "sig")
            val encrypting = publicJwk(encryption.public as ECPublicKey, "enc")
            publicDevice = JSONObject().put("deviceId", "mobile_${UUID.randomUUID()}").put("kind", "mobile").put("name", "Android")
                .put("signKey", signing).put("encryptionKey", encrypting)
            saved.put("identity", publicDevice).put("encryptionPrivate", Base64.encodeToString(encryptionPrivate.encoded, Base64.NO_WRAP))
            store.write(saved)
        }
    }
    }

    fun sign(value: JSONObject, purpose: String): String {
        require(value.toString().toByteArray().size <= 65536)
        val jws = JWSObject(JWSHeader.Builder(JWSAlgorithm.ES256).keyID(publicDevice.getJSONObject("signKey").getString("kid"))
            .type(JOSEObjectType("vh1:$purpose")).build(), Payload(value.toString()))
        jws.sign(ECDSASigner(signPrivate, Curve.P_256))
        return jws.serialize()
    }
    fun seal(value: JSONObject, recipientKey: JSONObject, purpose: String = "message"): String {
        val key = checkedKey(recipientKey, "enc")
        val jwe = JWEObject(JWEHeader.Builder(JWEAlgorithm.ECDH_ES, EncryptionMethod.A256GCM)
            .keyID(key.keyID).type(JOSEObjectType("vh1:encrypted")).contentType("JWS").build(), Payload(sign(value, purpose)))
        jwe.encrypt(ECDHEncrypter(key))
        return jwe.serialize()
    }
    fun open(envelope: String, senderKey: JSONObject, purpose: String = "message"): JSONObject {
        require(envelope.length <= 262144)
        val jwe = JWEObject.parse(envelope)
        val header = jwe.header.toJSONObject()
        require(header.keys.all { it in setOf("alg", "enc", "kid", "typ", "cty", "epk") })
        require(jwe.header.algorithm == JWEAlgorithm.ECDH_ES && jwe.header.encryptionMethod == EncryptionMethod.A256GCM)
        require(jwe.header.type.toString() == "vh1:encrypted" && jwe.header.contentType == "JWS")
        require(jwe.header.keyID == publicDevice.getJSONObject("encryptionKey").getString("kid"))
        val epk = jwe.header.ephemeralPublicKey as? ECKey ?: error("invalid_ephemeral_key")
        require(epk.curve == Curve.P_256 && !epk.isPrivate)
        jwe.decrypt(ECDHDecrypter(encryptionPrivate, emptySet(), Curve.P_256))
        return verify(jwe.payload.toString(), senderKey, purpose)
    }
    companion object {
        private val IDENTITY_LOCK = Any()
        fun publicJwk(key: ECPublicKey, use: String): JSONObject {
            val ec = ECKey.Builder(Curve.P_256, key).keyUse(if (use == "sig") KeyUse.SIGNATURE else KeyUse.ENCRYPTION)
                .algorithm(if (use == "sig") JWSAlgorithm.ES256 else JWEAlgorithm.ECDH_ES).build()
            return JSONObject(ec.toJSONObject()).put("kid", "$use:${ec.computeThumbprint()}")
        }
        fun checkedKey(value: JSONObject, use: String): ECKey {
            require(value.keys().asSequence().toSet() == setOf("kty", "crv", "x", "y", "use", "alg", "kid"))
            val key = ECKey.parse(value.toString())
            require(key.curve == Curve.P_256 && !key.isPrivate && value.getString("use") == use)
            require(value.getString("alg") == if (use == "sig") "ES256" else "ECDH-ES")
            require(key.keyID == "$use:${key.computeThumbprint()}")
            return key
        }
        fun verify(signed: String, senderKey: JSONObject, purpose: String): JSONObject {
            require(signed.length <= 100000)
            val key = checkedKey(senderKey, "sig")
            val jws = JWSObject.parse(signed)
            require(jws.header.toJSONObject().keys.all { it in setOf("alg", "kid", "typ") })
            require(jws.header.algorithm == JWSAlgorithm.ES256 && jws.header.keyID == key.keyID && jws.header.type.toString() == "vh1:$purpose")
            require(jws.verify(ECDSAVerifier(key))) { "invalid_signature" }
            require(jws.payload.toBytes().size <= 65536)
            return JSONObject(jws.payload.toString())
        }
        fun sha256(text: String): String = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        fun canonical(value: Any?): String = when (value) {
            null, JSONObject.NULL -> "null"
            is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { quoteCanonical(it) + ":" + canonical(value.get(it)) }
            is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
            is String -> quoteCanonical(value)
            else -> value.toString()
        }
        private fun quoteCanonical(value: String): String = buildString {
            append('"')
            for (character in value) when (character) {
                '"' -> append("\\\""); '\\' -> append("\\\\"); '\b' -> append("\\b"); '\u000c' -> append("\\f")
                '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
                else -> if (character.code < 32) append("\\u%04x".format(character.code)) else append(character)
            }
            append('"')
        }
        fun fingerprint(transcript: JSONObject): String = sha256(canonical(transcript)).take(15).uppercase().chunked(5).joinToString("-")
    }
}
