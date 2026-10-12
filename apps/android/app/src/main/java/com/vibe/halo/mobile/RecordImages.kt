package com.vibe.halo.mobile

import android.graphics.BitmapFactory
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.vibe.halo.mobile.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private suspend fun bitmap(repo: CompanionRepository, source: MediaSource, item: RecordMedia, full: Boolean): ImageBitmap = withContext(Dispatchers.IO) {
    val bytes = repo.loadMedia(source, item, full); val meta = if (full) item.full else item.preview
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    require(options.outWidth == meta.width && options.outHeight == meta.height && options.outMimeType == meta.mime)
    requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)).asImageBitmap()
}

@Composable fun RecordImages(repo: CompanionRepository, source: MediaSource, references: List<String>) {
    key(source) { RecordImageGallery(references, { repo.listMedia(source) }, { item, full -> bitmap(repo, source, item, full) }) }
}

@Composable internal fun RecordImageGallery(references: List<String>, list: suspend () -> List<RecordMedia>, load: suspend (RecordMedia, Boolean) -> ImageBitmap) {
    var items by remember { mutableStateOf<List<RecordMedia>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    var selected by remember { mutableStateOf<RecordMedia?>(null) }
    LaunchedEffect(retry) {
        failed = false
        try { items = list() } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            failed = true
        }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val available = items.orEmpty().filter { item -> references.any { android.net.Uri.decode(it) == android.net.Uri.decode(item.reference) } }
        available.forEach { item ->
            ImagePreview(item, { load(item, false) }) { selected = item }
        }
        if (failed || items != null && available.size < references.size) {
            Text(tr("图片暂不可用，请确认电脑在线且图片已同步。"), fontSize = 12.sp)
            TextButton(onClick = { retry++ }) { Text(tr("重试")) }
        } else if (items == null) Text(tr("正在加载图片…"), fontSize = 12.sp)
    }
    selected?.let { item -> ImageViewer(item, { load(item, true) }) { selected = null } }
}

@Composable private fun ImagePreview(item: RecordMedia, load: suspend () -> ImageBitmap, open: () -> Unit) {
    var image by remember(item.id) { mutableStateOf<ImageBitmap?>(null) }; var retry by remember { mutableIntStateOf(0) }; var failed by remember { mutableStateOf(false) }
    LaunchedEffect(item.id, retry) {
        failed = false
        try { image = load() } catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; failed = true }
    }
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium) {
        Column(Modifier.padding(8.dp)) {
            image?.let { Image(it, tr("点击查看大图"), Modifier.fillMaxWidth().heightIn(max = 240.dp).clickable(onClick = open), contentScale = ContentScale.Fit) }
            TextButton(onClick = open) { Text(tr("点击查看大图")) }
            if (image == null) Text(tr(if (failed) "图片加载失败" else "正在加载图片…"), fontSize = 12.sp)
            if (failed) TextButton(onClick = { retry++ }) { Text(tr("重试")) }
        }
    }
}

@Composable private fun ImageViewer(item: RecordMedia, load: suspend () -> ImageBitmap, close: () -> Unit) {
    var image by remember(item.id) { mutableStateOf<ImageBitmap?>(null) }; var failed by remember { mutableStateOf(false) }; var retry by remember { mutableIntStateOf(0) }
    var scale by remember { mutableFloatStateOf(1f) }; var offset by remember { mutableStateOf(Offset.Zero) }; var viewport by remember { mutableStateOf(IntSize.Zero) }
    LaunchedEffect(item.id, retry) {
        failed = false
        try { image = load() } catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; failed = true }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().systemBarsPadding()) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = close) { Text(tr("关闭")) }
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { scale = (scale / 1.5f).coerceAtLeast(1f); offset = Offset.Zero }) { Text("−", fontSize = 22.sp) }
                    TextButton(onClick = { scale = 1f; offset = Offset.Zero }) { Text(tr("重置")) }
                    TextButton(onClick = { scale = (scale * 1.5f).coerceAtMost(5f) }) { Text("+", fontSize = 22.sp) }
                }
                Box(Modifier.fillMaxWidth().weight(1f).graphicsLayer { clip = true }.onSizeChanged { viewport = it }
                    .pointerInput(item.id) { detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 5f)
                        val limitX = viewport.width * (scale - 1) / 2; val limitY = viewport.height * (scale - 1) / 2
                        offset = Offset((offset.x + pan.x).coerceIn(-limitX, limitX), (offset.y + pan.y).coerceIn(-limitY, limitY))
                    } }.pointerInput(item.id) { detectTapGestures(onDoubleTap = { scale = if (scale > 1f) 1f else 2.5f; offset = Offset.Zero }) }, contentAlignment = Alignment.Center) {
                    image?.let { Image(it, tr("图片大图"), Modifier.fillMaxSize().semantics { stateDescription = "${(scale * 100).toInt()}%" }.graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y }, contentScale = ContentScale.Fit) }
                    if (image == null) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(tr(if (failed) "图片加载失败" else "正在加载图片…"))
                        if (failed) TextButton(onClick = { retry++ }) { Text(tr("重试")) }
                    }
                }
                Text(tr("双指缩放，拖动查看；双击可放大或还原。"), Modifier.padding(16.dp), fontSize = 12.sp)
            }
        }
    }
}
