package com.vibe.halo.mobile

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.sp
import com.vibe.halo.mobile.notifications.CompanionNotifications
import com.vibe.halo.mobile.notifications.NotificationRetention
import kotlin.math.roundToInt

@Composable fun NotificationRetentionCard() {
    val context = LocalContext.current
    var minutes by remember { mutableIntStateOf(NotificationRetention.minutes(context)) }
    HaloCard {
        Text(tr("通知自动清理"), fontSize = 20.sp)
        Text("$minutes " + tr("分钟"), fontSize = 22.sp)
        Slider(value = minutes.toFloat(), onValueChange = { minutes = it.roundToInt() },
            onValueChangeFinished = { CompanionNotifications.setRetentionMinutes(context, minutes) },
            valueRange = NotificationRetention.MIN_MINUTES.toFloat()..NotificationRetention.MAX_MINUTES.toFloat(),
            steps = NotificationRetention.MAX_MINUTES - NotificationRetention.MIN_MINUTES - 1,
            modifier = Modifier.fillMaxWidth().testTag("notification-retention"))
        Text(tr("3～30 分钟，默认 10 分钟。按收到通知的时间计算，已有通知会逐条更新。"), fontSize = 13.sp)
        Text(tr("只清理通知栏；应用内消息和待处理请求仍会保留。"), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
