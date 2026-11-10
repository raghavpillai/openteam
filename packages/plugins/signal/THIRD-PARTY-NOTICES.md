# Runtime sources and notices

OpenTeam authors the JavaScript connector in this directory. It is distributed under this repository's GPL-3.0-only license. This is an unofficial integration, independent of Signal Technology Foundation and the signal-cli project.

The manifest pins these separately downloaded, unmodified runtime distributions. Their archives, notices and license files remain in the managed runtime cache. Installed/exported plugin ZIPs contain the connector and download descriptors, not these native distributions. No package manager or source compilation runs during connection.

The package also contains the **OpenTeam signal-cli 0.14.10-ot.1 compatibility overlay**, distributed under GPLv3. It carries modified copies of upstream `MessageEnvelope.java` and `JsonSyncMessage.java` plus OpenTeam's authenticated deletion projection and launcher. Corresponding modified source, build instructions, tests and the GPL text ship in `runtime-patch/`; source and license are embedded in the JAR as well. See [runtime-patch/README.md](runtime-patch/README.md). This overlay is an OpenTeam modification, not an upstream signal-cli release.

- **signal-cli 0.14.10**: https://github.com/AsamK/signal-cli/releases/tag/v0.14.10. Source: https://github.com/AsamK/signal-cli/tree/v0.14.10. GPLv3; see upstream LICENSE and bundled dependency notices. JVM distribution includes libsignal-client 0.106.1.
- **Eclipse Temurin JRE 25.0.5+8**: https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.5%2B8. OpenJDK source and source provenance are linked from that release and https://github.com/adoptium/temurin25-binaries. OpenJDK is GPLv2 with the Classpath Exception; additional notices are included in each runtime's legal directory.
- **Linux libsignal JNI 0.106.1**: https://github.com/exquo/signal-libs-build/releases/tag/libsignal_v0.106.1. These community-built artifacts supply native libraries absent from, or less portable than, the bundled JAR's Linux libraries. Upstream source: https://github.com/signalapp/libsignal/tree/v0.106.1 (AGPLv3). Build recipes and provenance: https://github.com/exquo/signal-libs-build. macOS uses the library already bundled in signal-cli's JAR.
- **Signal logo**: official Signal brand bundle, proportionally scaled. See assets/SOURCES.md. Signal trademarks belong to Signal Technology Foundation; use of the icon identifies the connected service and does not imply endorsement.

Each runtime source in plugin.json records an HTTPS URL, exact archive size, SHA-256 digest, extraction ceiling and entry point. connector/runtime-assets.json mirrors those pins for standalone validation. Update both deliberately and run the runtime and package tests before publishing an update.

QR rendering uses qrcode, pngjs and dijkstrajs under MIT licenses; their original license text is included in [QR-DEPENDENCY-LICENSES.md](QR-DEPENDENCY-LICENSES.md).
