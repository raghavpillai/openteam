# signal-cli 0.14.10 deletion compatibility

The unmodified high-level sync model drops `DeleteForMe`. Signal iOS uses that sync message for Note to Self deletion. The original authenticated protobuf is still present in `SignalServiceContent.serialize()`, so this small Java classpath overlay preserves deletion addressing through the manager and JSON layers.

The upstream runtime downloads remain unmodified. OpenTeam's managed launcher places `signal-cli-0.14.10-ot.1.jar` first on the classpath, then the pinned runtime's libraries. It checks the upstream JAR's actual manifest version and the patched method at startup. Other versions fail rather than silently running without deletion support. `signal_status.runtimePatch` identifies the compatibility revision. A developer's explicit `SIGNAL_CLI_PATH` override uses their supplied launcher and reports no bundled patch.

The overlay includes modified copies of these GPL source files from [AsamK/signal-cli v0.14.10](https://github.com/AsamK/signal-cli/tree/v0.14.10):

- `lib/src/main/java/org/asamk/signal/manager/api/MessageEnvelope.java`
- `src/main/java/org/asamk/signal/json/JsonSyncMessage.java`

`SyncDeletions.java` and `OpenTeamMain.java` are OpenTeam additions. Full corresponding modified source and the GPL license accompany the JAR and are also embedded under `META-INF/source/` and `META-INF/LICENSE`. The old sync constructor remains available for upstream D-Bus binary compatibility. No protocol encryption, trust, registration, or provider network logic is changed.

Only typed, authenticated own-device sync events can expose deletion metadata. Binary ACI/PNI identifiers pass through upstream's service-ID and recipient resolver; group IDs retain their upstream encoding. The projection includes addressing, timestamps and attachment identifiers, never the serialized content, cryptographic keys or message bodies.

## Build and verify

Maintainers need JDK **25.0.5+8**, Bun **1.4.2**, and the manifest-pinned signal-cli **0.14.10** distribution. Users connecting the plugin need only the managed JRE; installation performs no compilation or package-manager downloads.

From the repository root:

```sh
export SIGNAL_PATCH_JDK=/absolute/path/to/jdk-25.0.5+8
export SIGNAL_PATCH_CLI=/absolute/path/to/signal-cli-0.14.10
bun packages/plugins/signal/runtime-patch/build.ts
bun packages/plugins/signal/runtime-patch/build.ts --check
bun test packages/plugins/signal/connector/test/runtime-patch.test.ts
```

The build strips debug paths, sorts entries, fixes ZIP timestamps and embeds the exact sources. `--check` recompiles and compares the entire JAR byte-for-byte. The protocol test constructs real protobufs and verifies authenticated content → manager → JSON, including binary ACI, distinct PNI, known phone aliases, groups, attachments, and foreign sync rejection. Set `SIGNAL_TEST_EXECUTABLE` and `SIGNAL_TEST_JAVA_HOME` to exercise the real exported package with an empty temporary account. Optional Linux `SIGNAL_TEST_LIBSIGNAL` selects the pinned JNI library.

The Signal plugin GitHub workflow verifies the rebuild and real unlinked runtime on Linux x64, plus connector regressions. It downloads only manifest-pinned public runtimes and never links an account or creates a provisioning session. Any upstream upgrade requires reviewing and rebuilding this overlay, updating pins and repeating real phone deletion coverage.

## Collector boundaries

The collector persists revision relationships and tombstones so chained edits or reordered events do not revive deleted messages. For attachment-only deletion, it blocks all attachment references on the addressed message while retaining its text: the ordinary upstream attachment JSON lacks the cross-device identifiers needed to choose one local attachment safely. Replays and edits cannot restore those references.

Whole-conversation deletion requires an observed local message anchor and preserves later arrivals. Missing anchors and local-only metadata deletions never trigger a broad message wipe. Previously consumed empty sync events cannot be reconstructed; this patch fixes future delivered events.
