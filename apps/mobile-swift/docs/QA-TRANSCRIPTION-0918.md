# Native mobile transcription QA — September 18, 2026

Real speech-to-text passed through the Swift app, an authenticated production server with a disposable database, and the same live Parakeet provider configured on the main server. The earlier recording test uploaded a tone and received a canned transcript; it did not establish speech recognition.

## Actual speech test

The iPhone 16 Pro Max simulator on iOS 26.5 received a known spoken WAV through an explicitly enabled, debug-only audio source. The app wrote real mono 24 kHz AAC, stopped recording, uploaded `audio/mp4` to `/api/v0/transcriptions`, displayed the recognized words in the composer, and sent them. The test confirmed durable server storage and that transcription did not automatically send the draft.

Spoken input: “Please remind me to bring the blue notebook to our meeting tomorrow at nine.”

Actual result: “Please remind me to bring the blue notebook to our meeting tomorrow at 9.”

One warm UI run took **1.41 seconds** from pressing Transcribe to the populated composer. This is a single local-service measurement, not a network or device performance benchmark.

Provider: `mlx-community/parakeet-tdt-0.6b-v3`, using the main server's configured OpenAI-compatible endpoint. The isolated server used image `openteam-iosqa-server:20260918`, real authentication, PostgreSQL, and a real worker/computer. No recognition response was mocked in the live tests. Source speech was synthesized using macOS Samantha and encoded by the Swift app; physical microphone samples were not captured.

## Bugs reproduced and fixed

1. **Leaving the chat during transcription changed its draft afterward.** A delayed response appended words after navigation had discarded the recording. The app now cancels the task when the composer disappears and rejects late results/errors when the recording or signed-in server session changes. The regression failed before the fix and passes afterward.
2. **Transcription used ordinary HTTP deadlines.** The app's 35-second request and 60-second resource limits were shorter than the server's 120-second ASR allowance. Transcription now uses a dedicated 135-second request/resource budget, retaining authentication and the redirect policy. Other requests retain their existing limits. A delayed-response test failed before the fix; the final regression passes with a **70-second** response delay.

The new test audio source also needed to pad silence after its speech file ended instead of reading past EOF. This was a QA harness issue, not a physical recording defect. The source and its environment switch are excluded from device/release builds.

## Verification

| Check | Result |
| --- | --- |
| Real speech → AAC → actual ASR → composer → durable send | Passed |
| Existing draft survives discard and subsequent voice insertion | Passed |
| Real silence → “No speech” → retry → discard → usable composer | Passed |
| Leaving the chat while a response is pending preserves the draft | Passed |
| Transcription response delayed 70 seconds | Passed |
| Recording controls and failed upload followed by retry | Passed, controlled fixture |
| Headless microphone failure leaves typing usable | Passed |
| Swift transport tests, including binary audio/auth/timeout override | 9 passed |
| Server transcription tests | 25 passed |

UI scenarios above are grouped into **2 live tests and 4 controlled tests**. With transport and server coverage, **40 tests passed**. Simulator ad-hoc signing remained enabled.

## Evidence and repeatability

Evidence is under `output/swift-transcription-0918/`: `LiveSpeechFinal.xcresult`, `VoiceRegressionBefore.xcresult`, `VoiceRegressionFinal.xcresult`, their JSON summaries, `transcript.txt`, `voice-transcribed.png`, `voice-existing-draft.png`, and the silence screenshots. `direct-live-response.json` records an independent authenticated HTTP 200 upload with the same transcript. `live-state-final.json` records the persisted QA message. Unit results are in `transport-tests.log` and `server-tests.log`.

The live harness opts into ASR with `SWIFT_REAL_QA_TRANSCRIPTION_CONTAINER`, `SWIFT_REAL_QA_VOICE_WAV`, and `SWIFT_REAL_QA_SILENCE_WAV`. WAV files must be mono 24 kHz. The speech test expects the sentence above and accepts “nine” or “9.” Run the `RealServer` scheme with `testLiveVoiceTranscriptionAndDraftPreservation` and `testLiveSilentRecordingCanRetryAndDiscard`. Fixtures are downloaded from loopback; uploads go directly to the authenticated server.

Provider credentials remain in subprocess pipes and encrypted disposable storage. The harness deletes copied transcription settings on shutdown. The disposable database and services were removed/stopped. The main server's settings were not changed, and its HTTP health check remained ready.

## Remaining device acceptance

No physical iPhone was connected. This proves the mobile AAC/upload/ASR/composer/send flow, not actual iPhone microphone capture, Bluetooth routing, or device audio interruptions. The debug source bypasses physical recording permission/capture. A real-device recording remains required to sign off that hardware path. TestFlight remains **0.0.1 (25)**; this pass does not upload a new build.

Release follow-up: the fixes were subsequently uploaded on September 19 as [TestFlight 0.0.1 (26)](TESTFLIGHT-26.md), verified available to Team (Expo).
