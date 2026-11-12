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

    fun apply(context: Context, builder: Notification.Builder, agentId: String?, client: String, title: String, body: String) {
        // Older encrypted previews carry the display name without an agent ID.
        val id = agentId?.takeIf { it.isNotBlank() } ?: when (client) {
            "Codex" -> "codex"
            "Claude Code" -> "claude-code"
            else -> ""
        }
        val brand = when (id) {
            "codex" -> Brand(context.getColor(R.color.notification_codex), R.drawable.notification_codex)
            "claude-code" -> Brand(context.getColor(R.color.notification_claude), R.drawable.notification_claude)
            else -> return
        }
        fun layout(expanded: Boolean): RemoteViews {
            val largeText = context.resources.configuration.fontScale > 1.3f
            return RemoteViews(context.packageName, if (expanded) R.layout.notification_client_expanded else R.layout.notification_client).apply {
                setInt(R.id.notification_accent, "setBackgroundColor", brand.color)
                setImageViewResource(R.id.notification_client_icon, brand.icon)
                setTextViewText(R.id.notification_title, title)
                setTextViewText(R.id.notification_body, body)
                // The system's collapsed custom-content area is only 48dp tall.
                // At large font sizes keep the title, with the preview on expansion.
                if (!expanded && largeText) setViewVisibility(R.id.notification_body, View.GONE)
                if (expanded && largeText) setInt(R.id.notification_body, "setMaxLines", 4)
            }
        }
        builder.setColor(brand.color)
            .setStyle(Notification.DecoratedCustomViewStyle())
            .setCustomContentView(layout(false))
            .setCustomBigContentView(layout(true))
            .setCustomHeadsUpContentView(layout(false))
            // Keep semantic text for accessibility and standard watch mirroring.
            .addExtras(Bundle().apply { putCharSequence(Notification.EXTRA_BIG_TEXT, body) })
    }
}
