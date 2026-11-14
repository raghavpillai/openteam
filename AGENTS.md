# Project Rules

## Android Debug Packaging

- Package the current working tree with `bash scripts/android/package-debug.sh`.
- On macOS, double-click `scripts/android/package-debug.command` for the same build.
- The script must use a compatible JDK 17–24 and run `:mobile:androidApp:assembleDebug`.
- SDK lookup order: `ANDROID_HOME`/`ANDROID_SDK_ROOT`, then `local.properties`, then `~/Library/Android/sdk`. Do not write `local.properties` into the repo just to build.
- Do not run `./gradlew` directly or experiment with JDKs (Android Studio's bundled JDK 25 is unsupported by AGP 8.11.1); always use the script.
- The generated APK is `apps/android/app/build/outputs/apk/debug/androidApp-debug.apk`.
- Report the absolute APK path and SHA-256 after every successful package.
- Preserve uncommitted source changes; the packaging command must not reset, clean, delete, or commit files.
- Packaging must not start development servers, backend services, frontend servers, or rendering scripts.
- Installing and launching on the Xiaomi device is a separate action handled by `bash scripts/android/run-xiaomi.sh`.
