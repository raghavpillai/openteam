# Project Rules

## Android Debug Packaging

- Package the current working tree with `bash scripts/android/package-debug.sh`.
- On macOS, double-click `scripts/android/package-debug.command` for the same build.
- The script must use a compatible JDK 17–24 and run `:mobile:androidApp:assembleDebug`.
- The generated APK is `apps/android/app/build/outputs/apk/debug/androidApp-debug.apk`.
- Report the absolute APK path and SHA-256 after every successful package.
- Preserve uncommitted source changes; the packaging command must not reset, clean, delete, or commit files.
- Packaging must not start development servers, backend services, frontend servers, or rendering scripts.
- Installing and launching on the Xiaomi device is a separate action handled by `bash scripts/android/run-xiaomi.sh`.
