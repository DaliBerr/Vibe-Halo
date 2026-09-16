package com.vibe.halo.mobile.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureStore(context: Context, val namespace: String = "default") {
    private val suffix = if (namespace == "default") "" else "-${DeviceCrypto.sha256(namespace).take(24)}"
    private val alias = ALIAS + suffix
    private val file = AtomicFile(File(context.noBackupFilesDir, "companion$suffix.enc"))
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun key(): SecretKey {
        if (!keyStore.containsAlias(alias)) {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
            }.generateKey()
        }
        return keyStore.getKey(alias, null) as SecretKey
    }
    fun read(): JSONObject = synchronized(UPDATE_LOCK) {
        if (!file.baseFile.exists()) return JSONObject()
        require(file.baseFile.length() <= 24 * 1024 * 1024) { "cache_too_large" }
        val envelope = JSONObject(file.openRead().use { it.readBytes().toString(Charsets.UTF_8) })
        require(envelope.getInt("version") == 1)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)))
        val plaintext = cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP))
        return JSONObject(plaintext.toString(Charsets.UTF_8))
    }
    fun write(value: JSONObject) = synchronized(UPDATE_LOCK) {
        val bytes = value.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 16 * 1024 * 1024) { "cache_too_large" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val envelope = JSONObject().put("version", 1).put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(bytes), Base64.NO_WRAP)).toString()
        val stream = file.startWrite()
        try { stream.write(envelope.toByteArray()); file.finishWrite(stream) } catch (error: Exception) { file.failWrite(stream); throw error }
    }
    fun update(transform: (JSONObject) -> Unit) = synchronized(UPDATE_LOCK) {
        val value = read(); transform(value); write(value)
    }
    companion object { private const val ALIAS = "vibe-halo-cache-v1"; private val UPDATE_LOCK = Any() }
}
