// 熊猫五福 Android：对齐 liuai/native 脚手架（阿里云镜像 + AGP 8.13 + Kotlin 2.1 Compose 插件）
pluginManagement {
    repositories {
        mavenLocal()
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/central")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/central")
        google()
        mavenCentral()
    }
}

rootProject.name = "panda-wufu-android"

include(":app")
include(":shared")
project(":shared").projectDir = file("../../kmp-shared")
