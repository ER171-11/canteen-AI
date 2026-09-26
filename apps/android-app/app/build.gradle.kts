import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun configValue(key: String, envKey: String, fallback: String): String =
    (localProps.getProperty(key) ?: System.getenv(envKey) ?: fallback).trim()

val bffBaseUrl = configValue("bff.base.url", "PANDA_BFF_BASE_URL", "http://10.0.2.2:8787")
val wechatAppId = configValue("wechat.app.id", "WECHAT_APP_ID", "")

android {
    namespace = "com.pandawufu.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pandawufu.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 33
        versionName = "0.2.22"
        buildConfigField("String", "BFF_BASE_URL", "\"$bffBaseUrl\"")
        buildConfigField("String", "WECHAT_APP_ID", "\"$wechatAppId\"")
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
            // 上线要求 HTTPS；本地 http BFF 仅 debug 明文
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":shared"))
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Compose（对齐 liuai/native BOM）
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // 微信开放平台移动应用登录
    implementation("com.tencent.mm.opensdk:wechat-sdk-android:6.8.24")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
