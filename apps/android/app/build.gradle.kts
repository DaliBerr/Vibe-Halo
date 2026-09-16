import java.util.zip.ZipFile

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.vibe.halo.mobile"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.vibe.halo.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        for ((field, property) in mapOf("FIREBASE_APP_ID" to "firebase.appId", "FIREBASE_API_KEY" to "firebase.apiKey", "FIREBASE_PROJECT_ID" to "firebase.projectId", "FIREBASE_SENDER_ID" to "firebase.senderId")) {
            val value = providers.gradleProperty(property).orElse("").get().replace("\\", "\\\\").replace("\"", "\\\"")
            buildConfigField("String", field, "\"$value\"")
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/protocolAssets"))
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/noticeAssets"))
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    packaging { resources.excludes += setOf("META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/DEPENDENCIES") }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
val copyProtocolAssets by tasks.registering(Copy::class) {
    from("../../../packages/protocol/schemas") { into("protocol") }
    from("../../../LICENSE", "../../../NOTICE.md")
    into(layout.buildDirectory.dir("generated/protocolAssets"))
}
tasks.named("preBuild") { dependsOn(copyProtocolAssets) }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.preview)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel)
    implementation(libs.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.nimbus)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.work)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.runner)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.test)
}

// Keep licensing notices even when duplicate META-INF files are excluded from DEX packaging.
val generateThirdPartyNotices by tasks.registering {
    val output = layout.buildDirectory.file("generated/noticeAssets/THIRD_PARTY_NOTICES.txt")
    inputs.files(rootProject.file("gradle/libs.versions.toml"), file("build.gradle.kts"), rootProject.file("settings.gradle.kts"))
    outputs.file(output)
    doLast {
        val notices = StringBuilder("Vibe Halo Android runtime dependencies\nProject license: AGPL-3.0-only. See LICENSE and NOTICE.md.\n\n")
        val artifacts = configurations.getByName("releaseRuntimeClasspath").resolvedConfiguration.resolvedArtifacts.sortedBy { it.moduleVersion.id.toString() }
        for (artifact in artifacts) {
            val id = artifact.moduleVersion.id
            notices.append("\n=== $id ===\n")
            val pom = configurations.detachedConfiguration(dependencies.create("${id.group}:${id.name}:${id.version}@pom")).resolve().single().readText()
            for (field in listOf("name", "url", "licenses", "developers")) {
                Regex("<$field>([\\s\\S]*?)</$field>").find(pom)?.let { notices.append(it.value).append("\n") }
            }
            ZipFile(artifact.file).use { zip ->
                zip.entries().asSequence().filter { !it.isDirectory && it.name.matches(Regex("(?i)(META-INF/)?(LICENSE|NOTICE|COPYING).*")) && it.size in 1..262144 }.forEach { entry ->
                    notices.append("\n${entry.name}\n").append(zip.getInputStream(entry).bufferedReader().use { it.readText() }).append("\n")
                }
            }
        }
        val file = output.get().asFile; file.parentFile.mkdirs(); file.writeText(notices.toString())
    }
}
tasks.named("preBuild") { dependsOn(generateThirdPartyNotices) }
