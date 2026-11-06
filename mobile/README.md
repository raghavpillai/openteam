# Shared Mobile Core

`mobile/shared` is the platform-independent Kotlin Multiplatform boundary for
Android and iOS. It currently establishes target scaffolding, typed protocol
primitives, an injectable transport and platform-service seam, and common
contract tests. It does not replace either native UI or claim that synchronization,
authentication flows, persistence adapters, or feature parity are complete.

From the repository root, use the Gradle wrapper with JDK 17 or newer:

```sh
./gradlew :mobile:shared:allTests
./gradlew :mobile:shared:assemble
./gradlew :mobile:shared:linkDebugFrameworkIosSimulatorArm64
```

The iOS framework target requires macOS/Xcode. The Android target uses Android
Gradle Plugin and requires the Android SDK. `OpenTeamTransport`,
`SecureSessionStore`, `MobileStateStore`, and `MobileClock` are integration
boundaries; platform implementations must enforce safe redirects, avoid logging
credentials, and scope persisted state by server and account.

The shared synchronization layer is in `com.openteam.mobile.core.Sync`. It
supports long-poll bootstrap from a durable decimal cursor, SSE frame parsing
with the same cursor acceptance path, bounded reconnect delays, paged history,
and a delivery journal that records pending, accepted, rejected, and unknown
outcomes. A 401 response invokes the supplied session-recovery callback before
the error is returned to the platform layer.
