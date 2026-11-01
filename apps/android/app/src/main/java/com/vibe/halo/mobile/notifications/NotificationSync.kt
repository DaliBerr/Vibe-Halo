package com.vibe.halo.mobile.notifications

import android.content.Context
import android.os.Build
import androidx.work.*
import com.vibe.halo.mobile.VibeHaloApplication
import com.vibe.halo.mobile.data.NotificationSyncResult
import com.vibe.halo.mobile.data.NotificationSyncTarget
import com.vibe.halo.mobile.security.DeviceCrypto
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/** One bounded, read-only fetch per pushed event; no background socket or polling. */
class NotificationSync(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val data = inputData.keyValueMap.mapValues { it.value.toString() }
        val target = NotificationSyncTarget.from(data) ?: return Result.failure()
        val started = android.os.SystemClock.elapsedRealtime()
        NotificationTiming.record("android_sync_start", data, "fcm")
        // Share the foreground repository and its mutex so a stale worker cannot
        // overwrite newer cached revisions or locally revoked bindings.
        val repository = (applicationContext as VibeHaloApplication).repository
        val result = withTimeoutOrNull(45000) {
            repository.load(startDiscovery = false)
            if (repository.state.value.loadError) NotificationSyncResult.RETRY else repository.syncNotification(target)
        } ?: NotificationSyncResult.RETRY
        NotificationTiming.record("android_sync_${result.name.lowercase(java.util.Locale.ROOT)}", data, "fcm", started)
        return when (result) {
            NotificationSyncResult.SYNCED, NotificationSyncResult.IGNORED -> Result.success()
            NotificationSyncResult.RETRY -> if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }
    companion object {
        fun enqueue(context: Context, data: Map<String, String>, highPriority: Boolean) {
            val target = NotificationSyncTarget.from(data) ?: return
            // WorkManager's database contains routing metadata only, never the
            // encrypted preview, message text, credentials or relay URL.
            val input = workDataOf("protocolVersion" to "1", "pcId" to target.pcId, "pcSessionEpoch" to target.epoch,
                "eventId" to target.eventId, "eventRevision" to target.revision.toString(), "kind" to target.kind)
            val builder = OneTimeWorkRequestBuilder<NotificationSync>().setInputData(input)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            // Earlier Android versions require a separate foreground-service
            // notification for expedited work. Use an ordinary one-shot there.
            if (highPriority && Build.VERSION.SDK_INT >= 31) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            val key = DeviceCrypto.sha256("${target.pcId}/${target.epoch}/${target.eventId}/${target.revision}")
            WorkManager.getInstance(context).enqueueUniqueWork("vibe-halo-event-$key", ExistingWorkPolicy.KEEP, builder.build())
            NotificationTiming.record("android_sync_queued", data, "fcm")
        }
    }
}
