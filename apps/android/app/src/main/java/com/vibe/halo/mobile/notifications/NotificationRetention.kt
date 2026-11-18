package com.vibe.halo.mobile.notifications

import android.content.Context
import android.os.Bundle
import androidx.work.*
import kotlinx.coroutines.delay

/** Local notification display lifetime; independent of event/approval validity. */
object NotificationRetention {
    const val DEFAULT_MINUTES = 10
    const val MIN_MINUTES = 3
    const val MAX_MINUTES = 30
    const val POSTED_AT = "com.vibe.halo.mobile.notification.POSTED_AT"
    const val MINUTES = "com.vibe.halo.mobile.notification.MINUTES"
    private const val PREFERENCE = "auto-clear-minutes"

    fun minutes(context: Context): Int = context.getSharedPreferences("notification-preferences", Context.MODE_PRIVATE)
        .getInt(PREFERENCE, DEFAULT_MINUTES).takeIf { it in MIN_MINUTES..MAX_MINUTES } ?: DEFAULT_MINUTES

    internal fun save(context: Context, minutes: Int) {
        durationMillis(minutes) // Validate before writing the preference.
        context.getSharedPreferences("notification-preferences", Context.MODE_PRIVATE).edit().putInt(PREFERENCE, minutes).apply()
    }

    fun durationMillis(minutes: Int): Long {
        require(minutes in MIN_MINUTES..MAX_MINUTES)
        return minutes * 60_000L
    }

    fun remainingMillis(postedAt: Long, now: Long, minutes: Int): Long =
        (postedAt.coerceAtMost(now) + durationMillis(minutes) - now).coerceAtLeast(0)

    fun extras(postedAt: Long, minutes: Int) = Bundle().apply { putLong(POSTED_AT, postedAt); putInt(MINUTES, minutes) }

    fun enqueueRefresh(context: Context, replace: Boolean = false) {
        WorkManager.getInstance(context).enqueueUniqueWork("notification-retention",
            if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<NotificationRetentionWorker>()
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, java.util.concurrent.TimeUnit.SECONDS).build())
    }
}

/** A bounded local update, not polling. Native OS timers own the actual expiry. */
class NotificationRetentionWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        // Let the platform's notification enqueue-rate estimate settle first.
        delay(1500)
        CompanionNotifications.refreshTimeouts(applicationContext, onlyChanged = true)
        val pending = applicationContext.getSystemService(android.app.NotificationManager::class.java).activeNotifications.any {
            it.tag?.startsWith("pc_") == true &&
                it.notification.extras.getInt(NotificationRetention.MINUTES) != NotificationRetention.minutes(applicationContext)
        }
        return if (pending && runAttemptCount < 3) Result.retry() else if (pending) Result.failure() else Result.success()
    }
}
