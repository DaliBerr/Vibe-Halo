package com.vibe.halo.mobile

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.vibe.halo.mobile.data.CompanionRepository
import com.vibe.halo.mobile.notifications.CompanionNotifications

class VibeHaloApplication : Application() {
    val repository by lazy { CompanionRepository(this) }
    override fun onCreate() {
        super.onCreate()
        UiLanguage.mode = getSharedPreferences("ui-preferences", MODE_PRIVATE).getString("language", "system") ?: "system"
        CompanionNotifications.channels(this)
        if (BuildConfig.FIREBASE_APP_ID.isNotEmpty() && FirebaseApp.getApps(this).isEmpty()) {
            FirebaseApp.initializeApp(this, FirebaseOptions.Builder().setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY).setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        }
    }
}
