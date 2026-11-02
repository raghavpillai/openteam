pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "openteam-mobile"
include(":mobile:shared")
include(":mobile:androidApp")
project(":mobile:androidApp").projectDir = file("apps/android/app")
