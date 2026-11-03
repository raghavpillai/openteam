# OpenTeam Android QA and release foundation

The Android app is being brought to parity with the native iOS client in stages. The QA surface is deliberately split by execution environment:

- `app/src/test` contains deterministic JVM tests for routing, data contracts, fixtures, and platform adapters.
- `app/src/androidTest` contains Compose and device checks that need an Android Activity, accessibility semantics, keyboard, or storage.
- `docs/android/parity-matrix.json` is the source of truth for the iOS scheme to Android check mapping.
- `scripts/android/qa.sh` validates the matrix, runs local Gradle checks, and writes a reviewable report.

## Local verification

Use JDK 17 or newer with Android SDK platform 35 and build tools 35.0.0. From the repository root:

```sh
bash scripts/android/qa.sh check
bash scripts/android/qa.sh unit
bash scripts/android/qa.sh assemble
```

For a one-click debug APK package from the current working tree, run:

```sh
bash scripts/android/package-debug.sh
```

On macOS, double-click `scripts/android/package-debug.command`. The command selects a compatible JDK, runs `:mobile:androidApp:assembleDebug`, and prints the absolute APK path and SHA-256. It does not install the APK or start a server.

The script uses `apps/android/gradlew` when a wrapper is supplied by the Android owners; otherwise it uses `gradle` from `PATH`. It does not start a server or modify signing state. To run connected tests, boot an emulator or attach a device and set its serial:

```sh
ANDROID_SERIAL=emulator-5554 bash scripts/android/qa.sh instrumentation
```

The full local sequence is available with `ANDROID_RUN_INSTRUMENTATION=1 bash scripts/android/qa.sh all`.

## One-click run/debug on the Xiaomi phone

Android Studio ships a committed run configuration named **Xiaomi Debug** that targets the Xiaomi `M154FF` device (`serial=a657db70`) and deploys the debug APK without a device chooser:

- `.idea/runConfigurations/Xiaomi_Debug.xml` — Android App configuration for `:mobile:androidApp` (`openteam-mobile.mobile.androidApp.main`)
- `.idea/deploymentTargetSelector.xml` — pins the deployment target to that device

After the first successful Gradle sync, select **Xiaomi Debug** in the run widget and press Run (or Debug). If the configuration shows `<no module>` or `Error: Module not specified`, restart Android Studio, choose `GRADLE_LOCAL_JAVA_HOME` under the Gradle settings, then run **Sync Project with Gradle Files**. The project uses `GRADLE_LOCAL_JAVA_HOME`, configured in `.gradle/config.properties` to use the installed OpenJDK 21, because Gradle 8.14.3 cannot compile this Kotlin DSL project on the bundled JBR 25. From a terminal the equivalent is:

```sh
bash scripts/android/run-xiaomi.sh            # build + install + launch
bash scripts/android/run-xiaomi.sh --logcat   # same, then stream logcat
```

See `docs/android/20261031-Xiaomi一键运行调试.md` for the full setup, prerequisites, and troubleshooting.

## Test and parity map

`AndroidParitySmokeTest` covers the sign-in surface, accessible controls, directory navigation, history rendering, draft entry, optimistic send, and sent delivery state using synthetic data. `ParityFixtureTest` keeps test content account-free and stable. Existing owner tests remain in their `shell`, `features`, and `platform` packages; the QA package must not absorb those ownership boundaries.

The iOS baselines are the `MessageParity`, `QAAudit`, `MessagePerformance`, `MotionPerformance`, `Acceptance`, `LiveHTTP`, and `RealServer` schemes. Run the generated report with:

```sh
python3 scripts/android/parity-report.py --check
python3 scripts/android/parity-report.py --check --output output/android-qa/parity-report.md
```

`scaffolded` and `covered` entries describe available checks. They do not replace device, live-server, or release-candidate validation described in the dated QA plan under `docs/android`.

## Release gate

Build release artifacts from a clean, tagged checkout after the debug QA checks pass. The release owner must provide signing material through the CI secret store or a local environment outside the repository; keystores, passwords, service-account JSON, and Play credentials must never be checked in or echoed in logs. Verify the final APK/AAB with `apksigner`, record its SHA-256 digest, and upload the digest beside the artifact.

Before Play submission, complete the security and performance rows in the parity matrix, run the connected smoke suite on the supported API range, check backup and cleartext settings, verify deep links from a cold launch, and confirm that release logs and resources contain no credentials. Store rollout should begin with an internal track and a reversible staged percentage.

The reproducible release gate is:

```sh
bash scripts/android/release-gate.sh all
```

It always runs credential-free parity, assetlinks-template, live-contract, FCM-payload, manifest, and dependency declaration checks. Supply `ANDROID_APK` and/or `ANDROID_AAB` for artifact digests and signing verification, `ANDROID_SERIAL` for device evidence, `ANDROID_PERFORMANCE_BASELINE` for the macrobenchmark schema, and `PLAY_SERVICE_ACCOUNT_JSON` plus the release environment for Play validation. Missing external inputs are reported as `PENDING`; `ANDROID_RELEASE_GATE_STRICT=1` turns those unavailable gates into failures. Secrets remain outside command arguments, logs, and the repository.
