# Voice notes

Dictate a message instead of typing it. Your recording is turned into text, which you can review before sending.

## Record a voice note

Select the microphone in the message box and speak. Then either:

- Stop recording to put the text in your message box, where you can edit it before sending. On iPhone, tap the arrow to transcribe it.
- On desktop, choose **Transcribe and send** to send it right away.

On desktop, press **⌘D** on macOS or **Ctrl+D** on Windows and Linux while you're typing a message to start dictating. Or hold the shortcut while you talk and release it to stop.

Recordings can be up to five minutes long. The audio isn't saved or attached to the conversation.

Check names, numbers, and instructions in the transcript before sending, especially when the bot will act on them.

## Set up transcription

Voice notes need a transcription service. Set it up once on the server and it works in all your apps.

1. Run `openteam model` on the server host and select the **Transcription** tab. The desktop settings panel currently directs you to configure transcription on the server.
2. Choose **OpenAI**, **Deepgram**, or **Custom / OpenAI-compatible**.
3. For OpenAI or Deepgram, enter that service's API key; the base URL and model are filled in (`gpt-transcribe` for OpenAI, `nova-3` for Deepgram). For another service, enter its base URL, model, and API key if it needs one. Leave **Language** blank to detect it automatically. Deepgram also accepts `multi` for supported languages mixed within one recording.
4. Turn on **Voice notes**.
5. Choose **Save transcription**, then **Test saved connection**.
6. Record a short note to check that it works.

Transcription uses its own API key. A ChatGPT or Claude sign-in for chat doesn't cover it. Changing the default model for new selections does not migrate an existing saved model.

To choose a microphone on desktop, open **Settings → General → System → Microphone**.
The **Microphone access** row shows whether permission is allowed, blocked, or not yet requested. Choose **Enable microphone** to request access, or **System settings** to manage it on macOS or Windows. The status refreshes when you return to OpenTeam.

## Use your own transcription service

Any service with an OpenAI-compatible transcription API works, as long as the OpenTeam server can reach it. To run one on an Apple silicon Mac, see the [self-hosted transcription guide](../reference/transcription-service.md#self-host-on-an-apple-silicon-mac).

The bundled local MLX / Parakeet service is configured under **Custom / OpenAI-compatible**. Set its reachable base URL (for example, `http://audio-server:18080/v1`), model `mlx-community/parakeet-tdt-0.6b-v3`, and the key used to start the service. Selecting a custom provider does not start or install the local service.

## Troubleshooting

- **The microphone button is unavailable:** transcription is turned off or not set up on the server.
- **Recording doesn't start:** check that OpenTeam has microphone permission in your device's settings.
- **No speech was detected:** check the selected microphone, connection, mute control, and system input volume. Use your system’s sound settings to check whether the input meter moves while you speak. An allowed permission status does not verify that the microphone captures sound.
- **Transcription fails:** use **Test saved connection** in `openteam model`, then try a short recording. If a note fails, retry or discard it; it wasn't sent.
