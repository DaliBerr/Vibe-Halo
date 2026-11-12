package com.vibe.halo.mobile.notifications

import android.app.Notification
import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import com.vibe.halo.mobile.R

/** Client branding stays inside Android's notification template. */
internal object NotificationAppearance {
    private data class Brand(val color: Int, val icon: Int)

    private val brands = mapOf(
        "codex" to Brand(R.color.notification_codex, R.drawable.notification_codex),
        "zcode" to Brand(R.color.notification_zcode, R.drawable.notification_zcode),
        "qwen-code" to Brand(R.color.notification_qwen_code, R.drawable.notification_qwen_code),
        "copilot-cli" to Brand(R.color.notification_copilot_cli, R.drawable.notification_copilot_cli),
        "claude-code" to Brand(R.color.notification_claude, R.drawable.notification_claude),
        "codebuddy" to Brand(R.color.notification_codebuddy, R.drawable.notification_codebuddy),
        "hermes" to Brand(R.color.notification_hermes, R.drawable.notification_hermes),
        "opencode" to Brand(R.color.notification_opencode, R.drawable.notification_opencode),
        "deepseek-harness" to Brand(R.color.notification_deepseek_harness, R.drawable.notification_deepseek_harness),
        "kimi-code" to Brand(R.color.notification_kimi_code, R.drawable.notification_kimi_code),
        "qoder" to Brand(R.color.notification_qoder, R.drawable.notification_qoder),
        "qoderwork" to Brand(R.color.notification_qoderwork, R.drawable.notification_qoderwork),
        "gemini-cli" to Brand(R.color.notification_gemini_cli, R.drawable.notification_gemini_cli),
        "antigravity" to Brand(R.color.notification_antigravity, R.drawable.notification_antigravity),
        "cursor-agent" to Brand(R.color.notification_cursor_agent, R.drawable.notification_cursor_agent),
        "kiro" to Brand(R.color.notification_kiro, R.drawable.notification_kiro),
        "codewhale" to Brand(R.color.notification_codewhale, R.drawable.notification_codewhale),
        "pi" to Brand(R.color.notification_pi, R.drawable.notification_pi),
        "openclaw" to Brand(R.color.notification_openclaw, R.drawable.notification_openclaw),
        "reasonix" to Brand(R.color.notification_reasonix, R.drawable.notification_reasonix)
    )

    fun apply(context: Context, builder: Notification.Builder, agentId: String?, client: String, title: String, body: String) {
        // Older encrypted previews carry only the exact client display name.
        val id = agentId?.takeIf { it.isNotBlank() }
            ?: brands.keys.firstOrNull { NotificationPreview.agentName(it) == client }
        val brand = brands[id] ?: return
        val color = context.getColor(brand.color)
        fun layout(expanded: Boolean): RemoteViews {
            val largeText = context.resources.configuration.fontScale > 1.3f
            return RemoteViews(context.packageName, if (expanded) R.layout.notification_client_expanded else R.layout.notification_client).apply {
                setInt(R.id.notification_accent, "setBackgroundColor", color)
                setImageViewResource(R.id.notification_client_icon, brand.icon)
                setTextViewText(R.id.notification_title, title)
                setTextViewText(R.id.notification_body, body)
                // The system's collapsed custom-content area is only 48dp tall.
                // At large font sizes keep the title, with the preview on expansion.
                if (!expanded && largeText) setViewVisibility(R.id.notification_body, View.GONE)
                if (expanded && largeText) setInt(R.id.notification_body, "setMaxLines", 4)
            }
        }
        builder.setColor(color)
            .setStyle(Notification.DecoratedCustomViewStyle())
            .setCustomContentView(layout(false))
            .setCustomBigContentView(layout(true))
            .setCustomHeadsUpContentView(layout(false))
            // Keep semantic text for accessibility and standard watch mirroring.
            .addExtras(Bundle().apply { putCharSequence(Notification.EXTRA_BIG_TEXT, body) })
    }
}
