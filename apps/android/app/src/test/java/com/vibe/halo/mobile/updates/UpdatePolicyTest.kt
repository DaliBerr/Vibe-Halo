package com.vibe.halo.mobile.updates

import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
    private val installed = InstalledUpdateApp(UPDATE_PACKAGE, "0.6.6", 6, setOf("original"))
    private val update = AndroidUpdate("0.6.6", 7, 123, "a".repeat(64), "b".repeat(40))

    @Test fun newerBuildsCanKeepTheVisibleVersionWithoutOfferingDowngrades() {
        assertTrue(update.newerThan(installed))
        assertFalse(update.newerThan(installed.copy(versionCode = 7)))
        assertFalse(update.newerThan(installed.copy(versionCode = 8)))
        assertFalse(update.newerThan(installed.copy(packageName = "$UPDATE_PACKAGE.debug")))
        assertFalse(update.copy(versionName = "0.6.5").newerThan(installed))
        assertTrue(update.copy(versionName = "0.7.0").newerThan(installed))
        assertFalse(update.newerThan(installed.copy(versionName = "0.7.0")))
    }

    @Test fun archivesMustMatchPackageVersionBuildPlatformAndEveryCurrentSigner() {
        val archive = installed.copy(versionCode = 7)
        assertTrue(validUpdateArchive(update, installed, archive, 26, 34))
        for (bad in listOf(archive.copy(packageName = "other.app"), archive.copy(versionCode = 8), archive.copy(versionName = "0.6.7"),
            archive.copy(signers = emptySet()), archive.copy(signers = setOf("untrusted")), archive.copy(signers = setOf("original", "extra")))) {
            assertFalse(validUpdateArchive(update, installed, bad, 26, 34))
        }
        assertFalse(validUpdateArchive(update, installed, archive, 35, 34))
        assertFalse(validUpdateArchive(update, installed.copy(signers = emptySet()), archive, 26, 34))
    }

    @Test fun metadataIsBoundedAndHasNoRemoteProvidedFilenameOrDestination() {
        assertEquals("https://github.com/DaliBerr/Vibe-Halo/releases/download/v0.6.6/Vibe-Halo-Mobile-0.6.6.apk", update.apkUrl)
        for (invalid in listOf(update.copy(versionCode = 0), update.copy(versionCode = Int.MAX_VALUE.toLong() + 1), update.copy(size = 0),
            update.copy(size = MAX_APK_BYTES + 1), update.copy(sha256 = "x".repeat(64)), update.copy(sourceCommit = "main"), update.copy(versionName = "../../evil"))) {
            try { invalid.checked(); fail("Rejected malformed update") } catch (_: IllegalArgumentException) { }
        }
    }
}
