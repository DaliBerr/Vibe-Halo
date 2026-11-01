package com.vibe.halo.mobile

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibe.halo.mobile.updates.*
import kotlinx.coroutines.launch

@Composable fun AppUpdateCard(manager: AppUpdateManager = (LocalContext.current.applicationContext as VibeHaloApplication).appUpdates) {
    val state by manager.state.collectAsState()
    val scope = rememberCoroutineScope()
    var permissionRevision by remember { mutableIntStateOf(0) }
    val installer = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { permissionRevision++ }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { permissionRevision++ }
    val allowed = remember(permissionRevision, state.phase) { manager.canInstall() }
    val busy = state.phase in listOf(UpdatePhase.CHECKING, UpdatePhase.DOWNLOADING, UpdatePhase.VERIFYING)
    HaloCard {
        Text(tr("应用更新"), fontSize = 20.sp)
        Text(tr("当前版本") + " ${BuildConfig.VERSION_NAME}", fontSize = 13.sp)
        state.update?.let { Text(tr("可用版本") + " ${it.versionName} · ${"%.1f".format(it.size / 1048576.0)} MB", Modifier.padding(top = 8.dp)) }
        val message = when (state.phase) {
            UpdatePhase.CHECKING -> "正在检查更新…"
            UpdatePhase.CURRENT -> "已是最新版本"
            UpdatePhase.AVAILABLE -> if (state.update?.versionName == BuildConfig.VERSION_NAME) "此版本有新的更新包。" else "在应用内下载更新，安装前由系统确认。"
            UpdatePhase.DOWNLOADING -> "正在下载更新…"
            UpdatePhase.VERIFYING -> "正在校验安装包…"
            UpdatePhase.READY -> if (allowed) "下载完成，可以安装更新。" else "首次安装更新需要允许 Vibe Halo 安装应用，随后由系统确认安装。"
            UpdatePhase.ERROR -> when (state.problem) {
                UpdateProblem.RATE_LIMIT -> "更新服务暂时受限，请稍后重试。"
                UpdateProblem.METADATA -> "更新信息校验失败，请稍后重新检查。"
                UpdateProblem.PACKAGE -> "安装包校验失败，请重新下载。"
                UpdateProblem.INSTALLER -> "无法打开系统安装程序，请检查安装权限后重试。"
                else -> "更新未完成，请检查网络和存储空间后重试。"
            }
            else -> if (manager.supported) "在应用内下载更新，安装前由系统确认。" else "开发版本请使用开发包更新。"
        }
        Text(tr(message), Modifier.padding(top = 8.dp), fontSize = 13.sp)
        if (state.phase == UpdatePhase.DOWNLOADING) {
            LinearProgressIndicator(progress = { state.progress / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
            Text("${state.progress}%", fontSize = 12.sp)
        } else if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 12.dp))
        Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            if (state.phase == UpdatePhase.READY) Button(onClick = {
                if (!manager.canInstall()) runCatching { permission.launch(manager.permissionIntent()) }.onFailure { manager.installerUnavailable() }
                else scope.launch { manager.installIntent()?.let { intent -> runCatching { installer.launch(intent) }.onFailure { manager.installerUnavailable() } } }
            }, Modifier.fillMaxWidth()) { Text(tr(if (allowed) "安装更新" else "允许安装更新")) }
            else if (state.update != null && !busy) Button(onClick = manager::download, Modifier.fillMaxWidth()) { Text(tr("下载更新")) }
            if (busy && state.phase != UpdatePhase.VERIFYING) TextButton(onClick = manager::cancel) { Text(tr("取消")) }
            if (!busy) OutlinedButton(onClick = manager::check, enabled = manager.supported, modifier = Modifier.fillMaxWidth()) { Text(tr("检查更新")) }
        }
    }
}
