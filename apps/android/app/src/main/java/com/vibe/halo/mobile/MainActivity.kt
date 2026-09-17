package com.vibe.halo.mobile

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.vibe.halo.mobile.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val repository get() = (application as VibeHaloApplication).repository
    private val target = mutableStateOf<Triple<String, String, String>?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge(); route(intent)
        lifecycleScope.launch {
            repository.load()
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                repository.resume()
                launch { repository.updates.collect { repository.refresh(); repository.checkReceipts() } }
                while (true) { repository.refresh(); repository.checkReceipts(); delay(30000) }
            }
        }
        if (FirebaseApp.getApps(this).isNotEmpty()) FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> lifecycleScope.launch { repository.registerPushToken(token) } }
        setContent { HaloTheme { CompanionApp(repository, target.value) { target.value = null } } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); route(intent); lifecycleScope.launch { repository.refresh() } }
    private fun route(intent: Intent?) {
        val pcId = intent?.getStringExtra("pcId"); val eventId = intent?.getStringExtra("eventId")
        val epoch = intent?.getStringExtra("pcSessionEpoch")
        if (pcId != null && eventId != null && epoch != null && pcId.length <= 100 && eventId.length <= 240 && epoch.length <= 100) target.value = Triple(pcId, eventId, epoch)
    }
    override fun onStop() { super.onStop(); repository.close() }
}

@Composable fun HaloTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xffa6d8c3), background = Color(0xff121917), surface = Color(0xff19231f), surfaceVariant = Color(0xff25352d))
    else lightColorScheme(primary = Color(0xff245d48), background = Color(0xfff5f7f2), surface = Color.White, surfaceVariant = Color(0xffe7eee4))
    MaterialTheme(colorScheme = colors, content = content)
}
