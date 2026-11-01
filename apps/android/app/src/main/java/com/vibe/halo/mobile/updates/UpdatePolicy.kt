package com.vibe.halo.mobile.updates

const val UPDATE_PACKAGE = "com.vibe.halo.mobile"
const val UPDATE_REPOSITORY = "DaliBerr/Vibe-Halo"
const val MAX_APK_BYTES = 64L * 1024 * 1024

data class AndroidUpdate(
    val versionName: String,
    val versionCode: Long,
    val size: Long,
    val sha256: String,
    val sourceCommit: String,
) {
    val tag get() = "v$versionName"
    val apkName get() = "Vibe-Halo-Mobile-$versionName.apk"
    val apkUrl get() = "https://github.com/$UPDATE_REPOSITORY/releases/download/$tag/$apkName"

    fun checked(): AndroidUpdate {
        require(Regex("[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}").matches(versionName))
        require(versionCode in 1..Int.MAX_VALUE.toLong())
        require(size in 1..MAX_APK_BYTES)
        require(Regex("[a-f0-9]{64}").matches(sha256))
        require(Regex("[a-f0-9]{40}").matches(sourceCommit))
        return this
    }

    fun newerThan(installed: InstalledUpdateApp): Boolean {
        checked()
        if (installed.packageName != UPDATE_PACKAGE || versionCode <= installed.versionCode) return false
        val current = installed.versionName.split('.').map { it.toIntOrNull() ?: return false }
        if (current.size != 3) return false
        val next = versionName.split('.').map(String::toInt)
        for (i in current.indices) if (next[i] != current[i]) return next[i] > current[i]
        return true // A replacement build can keep its visible version name.
    }
}

data class InstalledUpdateApp(val packageName: String, val versionName: String, val versionCode: Long, val signers: Set<String>)

fun validUpdateArchive(update: AndroidUpdate, installed: InstalledUpdateApp, archive: InstalledUpdateApp, minSdk: Int, sdk: Int): Boolean =
    update.newerThan(installed) && archive.packageName == installed.packageName && archive.versionName == update.versionName &&
        archive.versionCode == update.versionCode && minSdk in 1..sdk && installed.signers.isNotEmpty() && archive.signers == installed.signers

enum class UpdateProblem { NETWORK, RATE_LIMIT, METADATA, PACKAGE, STORAGE, INSTALLER }
class UpdateException(val problem: UpdateProblem) : java.io.IOException(problem.name)
