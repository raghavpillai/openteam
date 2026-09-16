# Transcription service

For recording controls and provider setup, see [Voice notes](../configuration/transcription.md). This reference covers a self-hosted provider, its API contract, diagnostics, and storage.

## Provider contract

The OpenTeam server sends `POST <baseUrl>/audio/transcriptions` with multipart `file`, `model`, `response_format=json`, optional `language`, and optional Bearer authentication. The service must return `{ "text": "..." }` and accept WAV and WebM recordings. Other protocols require an adapter. See [OpenAI speech-to-text documentation](https://developers.openai.com/api/docs/guides/speech-to-text).

Use a URL reachable from the server container, including `/v1` when required. Container `localhost` does not reach the host Mac. Only the server needs access to the transcription service; mobile continues using its normal OpenTeam URL.

OpenAI defaults to `https://api.openai.com/v1` and `whisper-1`; another supported transcription model can be entered manually. Clients refresh server capabilities approximately every 30 seconds or when reopened. A disabled, incomplete, or unsupported configuration leaves the microphone visible but disabled.

## Client behavior

Clients upload a complete recording. They do not stream audio or use Apple speech recognition. Transcription inserts at the cursor or replaces selected text; desktop preserves mention tokens. The submitted draft follows the normal text-message path without an additional model rewrite.

Desktop Enter stops recording for review; the arrow transcribes and sends. A second Enter during transcription requests sending when it finishes. Escape cancels. Holding the dictation shortcut for at least half a second records until release. iPhone keeps the draft and keyboard visible, with stop, send, and cancel controls. Opening a reply thread cancels recording in the main composer.

Desktop microphone selection is saved per computer and shared across app windows. If the chosen input disconnects, recording tries the system default once and retains the preference. Permission denial does not trigger fallback. Recording requests echo cancellation, noise suppression, and automatic gain control.

The local input meter requests permission only when clicked. It stops after 30 seconds, cancellation, settings closure, app hiding, an input change, or disconnection. It never records or uploads audio.

## Self-host on an Apple silicon Mac

The included `scripts/transcription/serve_mlx.py` serves one model using [MLX Audio](https://github.com/Blaizzy/mlx-audio). The default is `mlx-community/parakeet-tdt-0.6b-v3`. Run it natively on macOS for Metal acceleration. The Parakeet helper detects language automatically; the general provider language setting is intended for providers that support a language hint.

Requirements: Apple silicon, Python 3.12+, ffmpeg, and enough memory for the model. From the repository root:

```sh
python3.12 -m venv ~/.local/share/openteam/transcription/.venv
~/.local/share/openteam/transcription/.venv/bin/pip install -r scripts/transcription/requirements.txt
python3.12 -c 'from pathlib import Path; import secrets; p=Path.home()/".local/share/openteam/transcription/api-key"; p.touch(mode=0o600, exist_ok=False); p.write_text(secrets.token_urlsafe(48))'
~/.local/share/openteam/transcription/.venv/bin/python scripts/transcription/serve_mlx.py \
  --host 127.0.0.1 --port 18080 \
  --api-key-file ~/.local/share/openteam/transcription/api-key
```

Install ffmpeg first if needed (`brew install ffmpeg`). The key-generation command intentionally refuses to replace an existing key. Copy the generated key into the password field in Transcription settings, without committing it or putting it in chat. To accept server connections from another machine or a container, replace `127.0.0.1` with the Mac's reachable private interface address. Use HTTPS if traffic is not already protected by a private encrypted network.

The helper loads the model before serving requests, authenticates every endpoint, exposes `/health` and `/v1/models`, and accepts one note at a time. It normalizes audio using ffmpeg and deletes its temporary files afterward. Requests cannot choose a different model or invoke model-management endpoints. For persistent hosting, run the same command using launchd with absolute paths and a PATH containing ffmpeg. The first start may download missing model files; later starts reuse the Hugging Face cache.

## Doctor and operating limits

`openteam doctor` includes a **Voice notes / Transcription** check. It reads the configured provider through the server using the installation control token and checks that the model is discoverable from the server's network. No microphone, audio upload, or billed transcription is used for diagnostics.

- Not configured or disabled: warning; the rest of OpenTeam still works.
- Listed model and valid connection: pass. This verifies discovery, not transcription quality.
- Discovery unsupported (404/405) or model not listed: warning; try a note to verify a service that loads models on demand.
- Invalid credentials, unreachable endpoint, or corrupt settings: failure with a corrective message.

Clients stop recordings at five minutes and reject notes shorter than half a second. The server accepts at most 25 MiB per recording, two concurrent notes, and a two-minute upload/transcription deadline. The MLX helper independently enforces the five-minute duration and serializes GPU use; a second request receives a retryable busy error.

Stopping produces a transcript for review; cancellation discards the recording and aborts the request. A provider may finish computation already in progress after cancellation, but its late result is ignored. Failed transcriptions retain the recording for explicit retry or discard. Navigating away discards it. iPhone cancels active recording when backgrounded or interrupted.

Audio is not stored as a chat attachment. Desktop keeps it in memory; iPhone uses a temporary file removed on success, cancellation, or navigation (abandoned files older than a day are removed before a new recording). The OpenTeam server holds audio in memory only; the Mac helper uses temporary decode files. A selected external provider has its own retention policy.

Settings are stored in `transcription.json` within the server's agent-data volume. API keys are encrypted with a key derived from `OPENTEAM_AUTH_SECRET` (or its supported `BETTER_AUTH_SECRET` fallback), and the file is written atomically with mode 0600. Back up the auth secret with the volume. Changing that secret requires saving the transcription key again. Changing the provider or base URL clears the old key instead of forwarding it to a new endpoint. API responses expose only whether a key is saved.
