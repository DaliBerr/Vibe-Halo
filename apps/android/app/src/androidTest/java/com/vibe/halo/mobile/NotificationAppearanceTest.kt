package com.vibe.halo.mobile

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.ContextThemeWrapper
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibe.halo.mobile.notifications.CompanionNotifications
import com.vibe.halo.mobile.notifications.NotificationPreview
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import kotlin.math.roundToInt

@RunWith(AndroidJUnit4::class)
@Suppress("DEPRECATION") // Inspect the actual custom RemoteViews delivered to SystemUI.
class NotificationAppearanceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val clients = JSONArray(instrumentation.context.assets.open("notification-clients.json").bufferedReader().use { it.readText() })
        .let { rows -> (0 until rows.length()).map { rows.getJSONObject(it) } }
    private fun colorResource(name: String) = context.resources.getIdentifier(name, "color", context.packageName).also { assertTrue(it != 0) }

    @Test fun brandedCardsPreserveNativeTextReadOnlyIntentsAndPhoneOnlySummary() {
        val pc = "pc_${UUID.randomUUID()}"
        try {
            assertEquals(20, clients.size)
            for (client in clients) {
                val id = client.getString("id"); val name = client.getString("name"); val color = colorResource(client.getString("resource"))
                for (kind in listOf("completion", "plan", "approval", "question", "input")) {
                    val notification = post(context, pc, id, name, kind)
                    assertEquals(context.getColor(color), notification.color)
                    assertEquals("$name · ${CompanionNotifications.copy(kind).first}", notification.extras.getString(Notification.EXTRA_TITLE))
                    assertEquals("通知样式演示 — 修复已完成，点击查看完整消息。", notification.extras.getString(Notification.EXTRA_TEXT))
                    assertEquals(notification.extras.getCharSequence(Notification.EXTRA_TEXT), notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
                    assertNotNull(notification.contentView)
                    assertNotNull(notification.bigContentView)
                    assertNotNull(notification.headsUpContentView)
                    assertEquals(Notification.DecoratedCustomViewStyle::class.java.name, notification.extras.getString(Notification.EXTRA_TEMPLATE))
                    assertNotNull(notification.contentIntent)
                    assertNotNull(notification.deleteIntent)
                    assertTrue(notification.actions.isNullOrEmpty())
                    assertNull(notification.fullScreenIntent)
                    assertFalse(notification.flags and Notification.FLAG_LOCAL_ONLY != 0)
                    assertEquals(Notification.GROUP_ALERT_CHILDREN, notification.groupAlertBehavior)
                    assertFalse(notification.extras.getBoolean(Notification.EXTRA_COLORIZED))
                }
                val summary = manager.activeNotifications.single { it.tag == "$pc/_summary" }.notification
                assertTrue(summary.flags and Notification.FLAG_LOCAL_ONLY != 0)
                assertEquals("Vibe Halo", summary.extras.getString(Notification.EXTRA_TITLE))
                assertNull(summary.contentView)
                CompanionNotifications.clearPc(context, pc)
            }
        } finally { CompanionNotifications.clearPc(context, pc) }
    }

    @Test fun customLayoutsFitNarrowScreensDarkModeAndLargeFonts() {
        val pc = "pc_${UUID.randomUUID()}"
        val originalLanguage = UiLanguage.mode
        try {
            UiLanguage.mode = "zh-CN"
            for (night in listOf(false, true)) for (font in listOf(1f, 1.3f, 2f)) {
                val configured = themedContext(night, font)
                for (client in clients) {
                    val id = client.getString("id"); val name = client.getString("name"); val color = colorResource(client.getString("resource"))
                    assertEquals(Color.parseColor(client.getString(if (night) "dark" else "light")), configured.getColor(color))
                    val notification = post(configured, pc, id, name, "completion", "通知布局测试，中英文 long preview 😀。".repeat(10))
                    for (width in listOf(280, 360)) for (expanded in listOf(false, true)) {
                        instrumentation.runOnMainSync {
                            val remote = if (expanded) notification.bigContentView else notification.contentView
                            val root = remote.apply(configured, FrameLayout(configured))
                            val density = configured.resources.displayMetrics.density
                            fun dp(value: Int) = (value * density).roundToInt()
                            root.measure(View.MeasureSpec.makeMeasureSpec(dp(width), View.MeasureSpec.EXACTLY),
                                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                            // Respect the root's fixed height when measuring outside SystemUI.
                            if (!expanded) root.measure(View.MeasureSpec.makeMeasureSpec(dp(width), View.MeasureSpec.EXACTLY),
                                View.MeasureSpec.makeMeasureSpec(dp(48), View.MeasureSpec.EXACTLY))
                            root.layout(0, 0, root.measuredWidth, root.measuredHeight)
                            assertTrue("Custom content is too tall: $night/$font/$width/$expanded", root.height <= dp(if (expanded) 252 else 48))
                            val title = root.findViewById<TextView>(R.id.notification_title)
                            val body = root.findViewById<TextView>(R.id.notification_body)
                            assertTrue(title.text.startsWith(name))
                            val textGroup = title.parent as View
                            assertTrue("Title is clipped vertically", textGroup.top + title.bottom <= root.height - root.paddingBottom)
                            if (body.visibility == View.VISIBLE) assertTrue("Preview is clipped vertically", textGroup.top + body.bottom <= root.height - root.paddingBottom)
                            assertEquals(if (!expanded && font > 1.3f) View.GONE else View.VISIBLE, body.visibility)
                            val accent = root.findViewById<ImageView>(R.id.notification_accent)
                            assertEquals(configured.getColor(color), (accent.background as ColorDrawable).color)
                            assertTrue(accent.height > 0)
                            assertNotNull(root.findViewById<ImageView>(R.id.notification_client_icon).drawable)
                            if (font == 1f && width == 360) {
                                val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                                val canvas = Canvas(bitmap)
                                canvas.drawColor(Color.parseColor(if (night) "#28252D" else "#F3F0F6"))
                                root.draw(canvas)
                                val file = File(context.getExternalFilesDir("notification-previews"), "$id-${if (night) "dark" else "light"}-${if (expanded) "expanded" else "compact"}.png")
                                file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                                bitmap.recycle()
                                if (!expanded) {
                                    val icon = root.findViewById<ImageView>(R.id.notification_client_icon)
                                    val iconBitmap = Bitmap.createBitmap(icon.width, icon.height, Bitmap.Config.ARGB_8888)
                                    icon.draw(Canvas(iconBitmap))
                                    val pixels = IntArray(icon.width * icon.height)
                                    iconBitmap.getPixels(pixels, 0, icon.width, 0, 0, icon.width, icon.height)
                                    assertTrue("Missing or incorrectly colored glyph: $id/$night", pixels.any {
                                        Color.alpha(it) > 0 && (it and 0xFFFFFF) == (configured.getColor(color) and 0xFFFFFF)
                                    })
                                    iconBitmap.recycle()
                                }
                            }
                        }
                    }
                    CompanionNotifications.clearPc(context, pc)
                }
            }
        } finally { UiLanguage.mode = originalLanguage; CompanionNotifications.clearPc(context, pc) }
    }

    @Test fun legacyPreviewNamesAreBrandedAndUnknownClientsKeepStandardNotifications() {
        val pc = "pc_${UUID.randomUUID()}"
        try {
            for (client in clients) {
                assertEquals(client.getString("name"), NotificationPreview.agentName(client.getString("id")))
                assertNotNull(post(context, pc, null, client.getString("name"), "completion").contentView)
                CompanionNotifications.clearPc(context, pc)
            }
            for ((id, name) in listOf("vibe-halo" to "Vibe Halo", "unknown-client" to "Codex", "" to "Unknown")) {
                val notification = post(context, pc, id, name, "completion")
                assertNull(notification.contentView)
                assertEquals(Notification.BigTextStyle::class.java.name, notification.extras.getString(Notification.EXTRA_TEMPLATE))
                assertEquals(Notification.COLOR_DEFAULT, notification.color)
            }
        } finally { CompanionNotifications.clearPc(context, pc) }
    }

    @Test fun metadataOnlyNotificationsKeepEveryClientsCanonicalNameAndBrand() {
        val pc = "pc_${UUID.randomUUID()}"
        try {
            for (client in clients) {
                val name = client.getString("name")
                val notification = post(context, pc, client.getString("id"), name, "completion", withPreview = false)
                assertTrue(notification.extras.getString(Notification.EXTRA_TITLE)!!.startsWith("$name · "))
                assertNotNull(notification.contentView)
                assertEquals(context.getColor(colorResource(client.getString("resource"))), notification.color)
                CompanionNotifications.clearPc(context, pc)
            }
        } finally { CompanionNotifications.clearPc(context, pc) }
    }

    private fun themedContext(night: Boolean, font: Float): Context {
        val configuration = Configuration(context.resources.configuration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            fontScale = font
        }
        return ContextThemeWrapper(context.createConfigurationContext(configuration), android.R.style.Theme_DeviceDefault_DayNight)
    }

    private fun post(source: Context, pc: String, id: String?, name: String, kind: String, text: String = "修复已完成，点击查看完整消息。", withPreview: Boolean = true): Notification {
        val event = "evt_${UUID.randomUUID()}"
        val data = mutableMapOf("protocolVersion" to "1", "pcId" to pc, "eventId" to event, "eventRevision" to "1", "kind" to kind)
        if (id != null) data["agentId"] = id
        assertEquals("notification_posted", CompanionNotifications.show(source, data, if (withPreview) NotificationPreview(name, "通知样式演示", text) else null))
        val deadline = android.os.SystemClock.elapsedRealtime() + 3000
        while (manager.activeNotifications.none { it.tag == "$pc/$event" } && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
        return manager.activeNotifications.single { it.tag == "$pc/$event" }.notification
    }
}
