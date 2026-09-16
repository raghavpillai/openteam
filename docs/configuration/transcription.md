# Voice notes

Dictate a message, review the text, and send it to a bot. Voice notes use a transcription provider configured on your server.

## Use a voice note

Select the microphone in the composer and record your message. Stop to return the transcript to your draft, or use **Transcribe and send** when you are ready to send directly.

You can edit the transcript before sending. Check names, numbers, and instructions that would change files or contact someone. Cancel recording or transcription to discard it.

On desktop, **⌘D** or **Ctrl+D** toggles dictation while the draft is focused. You can also hold the shortcut and release it to stop. On mobile, use the recording controls in the composer.

## Configure

In desktop **Settings → Server → Transcription**:

1. Choose **OpenAI** or **Custom / OpenAI-compatible**.
2. Enter the provider's base URL, transcription model, and API key if required.
3. Leave language blank for automatic detection, or choose a supported language code.
4. Enable voice notes, save, and test the connection.
5. Record a short note to verify that actual transcription works.

These settings apply to clients connected to this server. A ChatGPT sign-in used for chat models does not supply transcription API access; transcription has its own credentials.

You can also configure transcription in the interactive `openteam model` editor.

## Use a self-hosted service

An OpenAI-compatible audio service can run on a machine you control. Its address must be reachable from the OpenTeam server, which makes the transcription request.

The repository includes an Apple-silicon helper for running a local model. Follow the [self-hosted transcription instructions](../reference/transcription-service.md#self-host-on-an-apple-silicon-mac) if you want that setup.

## Limits and troubleshooting

Recordings are limited to five minutes and 25 MiB. A disabled microphone usually means transcription is off, unconfigured, or unavailable on the connected server.

Check microphone permission on the device, then test the saved server configuration. A successful connection test checks discovery; a short recording checks transcription itself. If a request fails, use retry or discard rather than assuming the message was sent.

Audio is processed for transcription and is not added as a chat attachment. External providers have their own processing and retention policies.
