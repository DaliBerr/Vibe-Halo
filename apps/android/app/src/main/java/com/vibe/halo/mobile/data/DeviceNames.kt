package com.vibe.halo.mobile.data

import android.content.Context
import android.os.Build
import android.provider.Settings
import org.json.JSONObject

object DeviceNames {
    fun checked(value: String): String {
        val name = value.trim()
        require(name.codePointCount(0, name.length) in 1..48 && name.codePoints().noneMatch {
            Character.isISOControl(it) || (Character.getType(it) == Character.FORMAT.toInt() && it != 0x200d)
        }) { "invalid_device_name" }
        return name
    }
    fun system(context: Context): String {
        val found = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        val name = found?.takeIf { it.isNotBlank() } ?: listOf(Build.MANUFACTURER, Build.MODEL).distinct().joinToString(" ")
        return runCatching { checked(name.take(48)) }.getOrDefault("Mobile device")
    }
    fun current(context: Context): String {
        val prefs = context.getSharedPreferences("device-name", Context.MODE_PRIVATE)
        return prefs.getString("custom", null) ?: system(context)
    }
    fun set(context: Context, name: String?) {
        val edit = context.getSharedPreferences("device-name", Context.MODE_PRIVATE).edit()
        if (name == null) edit.remove("custom") else edit.putString("custom", checked(name))
        edit.putBoolean("initialized", true).apply()
    }
    fun migrate(context: Context, legacy: String?) {
        val prefs = context.getSharedPreferences("device-name", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("initialized", false)) set(context, legacy?.takeUnless { it in listOf("Android", "我的电脑", "My computer", "Vibe Halo", system(context)) })
    }
    fun profile(value: JSONObject, deviceId: String, origin: String): JSONObject {
        require(value.keys().asSequence().toSet() == setOf("protocolVersion", "deviceId", "relayOrigin", "revision", "name"))
        require(value.getInt("protocolVersion") == 1 && value.getString("deviceId") == deviceId && value.getString("relayOrigin") == origin)
        val revision = value.get("revision")
        require(revision is Number && revision.toDouble() == revision.toLong().toDouble() && revision.toLong() in 1..9007199254740991L)
        require(checked(value.getString("name")) == value.getString("name"))
        return value
    }
}
