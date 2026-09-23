# Voice notes

Dictate a message instead of typing it. Your recording is turned into text, which you can review before sending.

## Record a voice note

Select the microphone in the message box and speak. Then either:

- Stop recording to put the text in your message box, where you can edit it before sending.
- On desktop, choose **Transcribe and send** to send it right away.

On desktop, press **⌘D** on macOS or **Ctrl+D** on Windows and Linux while you're typing a message to start dictating. Or hold the shortcut while you talk and release it to stop.

Recordings can be up to five minutes long. The audio isn't saved or attached to the conversation.

Check names, numbers, and instructions in the transcript before sending, especially when the bot will act on them.

## Set up transcription

Voice notes need a transcription service. Set it up once on the server and it works in all your apps.

1. Open **Settings → Server → Transcription**.
2. Choose **OpenAI** or **Custom / OpenAI-compatible**.
3. Enter the base URL, model, and API key. Leave **Language** blank to detect it automatically.
4. Turn on **Voice notes**.
5. Choose **Save transcription**, then **Test connection**.
6. Record a short note to check that it works.

Transcription uses its own API key. A ChatGPT or Claude sign-in for chat doesn't cover it. You can also set up transcription from the host with `openteam model`.

To choose a microphone on desktop, open **Settings → General → System → Microphone**.

## Use your own transcription service

Any service with an OpenAI-compatible transcription API works, as long as the OpenTeam server can reach it. To run one on an Apple silicon Mac, see the [self-hosted transcription guide](../reference/transcription-service.md#self-host-on-an-apple-silicon-mac).

## Troubleshooting

- **The microphone button is unavailable:** transcription is turned off or not set up on the server.
- **Recording doesn't start:** check that OpenTeam has microphone permission in your device's settings.
- **Transcription fails:** use **Test connection** in settings, then try a short recording. If a note fails, retry or discard it; it wasn't sent.
