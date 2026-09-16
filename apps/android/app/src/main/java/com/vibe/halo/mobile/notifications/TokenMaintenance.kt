package com.vibe.halo.mobile.notifications

import android.content.Context
import androidx.work.*
import com.vibe.halo.mobile.data.CompanionRepository
import java.util.concurrent.TimeUnit

/** Bounded token maintenance only: never watches events or submits decisions. */
class TokenMaintenance(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val repository = CompanionRepository(applicationContext)
        return try {
            repository.load(startDiscovery = false)
            if (repository.syncMaintenance()) Result.success() else if (runAttemptCount < 4) Result.retry() else Result.failure()
        } finally { repository.close() }
    }
    companion object {
        fun enqueue(context: Context) {
            val work = OneTimeWorkRequestBuilder<TokenMaintenance>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("vibe-halo-token", ExistingWorkPolicy.REPLACE, work)
        }
    }
}
