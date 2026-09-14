# Input policy parity QA — September 14, 2026

This record covers the [message and attachment policy](../input-parity.md), including desktop and iOS selection, durable staging, server ingestion, runtime image processing, and Read output. It does not establish compaction parity or complete application equivalence.

## Reference and differential checks

The inspected reference was Grok Bot desktop 0.47.0 stable, host 886e13a, SHA-256 `d54bf2ea6a49e2dfad656c4889b4f202e92817fb00fa829aadbb6aa76dc5fecc`.

A local comparison harness verified that hash, extracted the reference functions, and executed them in an isolated VM against OpenTeam functions. Protobuf and localization were stubbed. This did not exercise GrokBot's network transport or model provider.

| Comparison | Cases | Differences |
| --- | ---: | ---: |
| Filename allowances | 16 | 0 |
| Empty, below, exact, and above byte boundaries | 80 | 0 |
| Selection count and existing capacity | 30 | 0 |
| Image geometry, including thin and zero-size inputs | 288 | 0 |
| Read ranges, CRLF, UTF-16 boundaries, empty files, and EOF errors | 336 | 0 |
| Total | 750 | 0 |

Read comparisons account for OpenTeam's line-number display wrapper. The reference bundle and local comparison harness are not distributed here. Regression tests and synthetic fixtures are committed under contracts, product-core, computer, mobile, desktop, messaging, and server tests; they run without that bundle.

## Functional checks

Desktop QA used the shipping React composer and durable staging adapter in a browser fixture with synthetic submission. The native file picker selected a 92-byte TXT, a 2400×1600 PNG, an empty TXT, and a 26,214,401-byte TXT. Two valid attachments remained and both invalid-file notices appeared. Selecting seven count fixtures staged six and showed the overflow notice. A 200,002-character message reached the submit handler with its final marker intact. This checks client staging and submission, not provider delivery.

On an iPhone 17 Pro simulator running iOS 26.5, the shipping composer opened the native Files sheet after the dismissal fix. Selection inside that sheet was not completed through computer use. Automated staging tests exercise real file copy/stat/rename/delete operations through a substitute Expo filesystem bridge in an isolated child process. Physical-device Photos/camera and native upload/send remain unverified.

Runtime tests cover a real PNG producing a 1024×683 derivative, progressive encoding below the byte target, preserved original bytes, malformed-image handling, WebP fallback, 25 MiB inline transport, paging an 11 MiB document, and extraction of the synthetic PDF fixture used in the investigation.

## Commit validation

The scoped changes were reconstructed and checked independently on base commit `f9ddd0e`, excluding concurrent work in the shared checkout. A frozen-lockfile install and Prisma client generation succeeded.

The combined contracts, product-core, asset storage, server preflight, desktop host/composer, mobile, native Read, runtime image, and steering run produced **395 passes, one existing macOS/CI Shell skip, and three failures**. Running the two affected mobile test files against unchanged base sources reproduced all three failures: attachment-label and voice-menu source assertions, and plugin category capitalization. No input-policy test failed.

Whole-workspace typechecking, desktop and computer production builds, the production iOS JavaScript export, and architecture checks passed for the isolated changes. The export is not an App Store archive or a physical-device test.

## Limits of the result

GrokBot's native iOS implementation and private Temporal harness were not inspected. The desktop-derived policy is applied to OpenTeam iOS. Ultimate message limits, provider request pixels, codec-specific output, rate/account quotas, video frame extraction, OCR, Office parsing, and audio duration/transcription are not established as equivalent. WebP follows the inspected box bundle's no-codec fallback; the active private service may have a codec. OpenTeam retains its own transport and tool-result wrappers, a 280 MiB server request-body ceiling, and a 16 MiB serialized durable-journal guard.
