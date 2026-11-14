# Voice notes

Speak a message instead of typing it. Your recording is turned into text and sent, or on desktop, put in the message box for you to edit.

## Record a voice note

**iPhone:** when the message box is empty, it shows a microphone.

- Tap the microphone to record hands-free, then tap send to transcribe and send it. The trash discards it; the stop button ends the recording so you can choose either.
- Or press and hold the microphone while you speak, and release to send. Slide left to cancel, or up to keep recording hands-free.

Once you've sent it, you can leave the chat. The note is still transcribed and sent, and if you come back before it's done, the chat shows it transcribing.

**Desktop:** select the microphone in the message box, or press **⌘D** on macOS or **Ctrl+D** on Linux while you're typing. You can also hold the shortcut while you talk. While you record:

- **Send voice note** transcribes the recording and sends it.
- To edit the text first, press Enter or the shortcut again, or release the shortcut you're holding. The text goes into your message box, where you can change it before sending.
- **Discard voice note** or Esc throws the recording away.

Recordings can be up to five minutes long. The audio isn't saved or attached to the conversation.

iPhone sends the transcript without letting you edit it. When a bot will act on names, numbers, or exact instructions, type them, or dictate on desktop and check the text first.

## Set up transcription

Voice notes need a transcription service. Set it up once on the server and it works in all your apps.

1. On desktop or iPhone, open **Settings → Voice notes**. Or run `openteam model` on the server host and select the **Transcription** tab.
2. Choose **OpenAI**, **Deepgram**, or **Custom / OpenAI-compatible**.
3. For OpenAI or Deepgram, enter that service's API key; the base URL and model are filled in (`gpt-transcribe` for OpenAI, `nova-3` for Deepgram). For another service, enter its base URL, model, and API key if it needs one. Leave **Language** blank to detect it automatically. Deepgram also accepts `multi` for supported languages mixed within one recording.
4. Turn on **Voice notes**.
5. Choose **Save**, then **Test connection**. In `openteam model`, use **Save transcription** and **Test saved connection**.
6. Record a short note to check that it works.

Transcription uses its own API key. A ChatGPT or Claude sign-in for chat doesn't cover it.

Saved keys stay on your server, and the apps show only their last four characters. Leave the key field blank to keep the saved key. To remove it, choose **Delete key**, then **Save**. To switch to a different provider or base URL, enter a new key or delete the saved one first.

To choose a microphone on desktop, open **Settings → General → System → Microphone**. If access is blocked, choose **Enable microphone** or **System settings** under **Microphone access**.

## Use your own transcription service

Any service with an OpenAI-compatible transcription API works, as long as the OpenTeam server can reach it.

To transcribe on your own Apple silicon Mac, the source repository includes an optional script, [`scripts/transcription/serve_mlx.py`](https://github.com/raghavpillai/openteam/blob/main/scripts/transcription/serve_mlx.py), that serves the Parakeet model. It isn't installed or started for you:

1. Install ffmpeg, and install the script's `requirements.txt` into a Python virtual environment.
2. Save a generated key of at least 32 characters in a file.
3. Run `python serve_mlx.py --api-key-file <file>`. It listens on `127.0.0.1:8000`; use `--host` and `--port` to choose an address the OpenTeam server can reach.
4. In **Settings → Voice notes**, choose **Custom / OpenAI-compatible**. Enter the script's address followed by `/v1` as the base URL (for example, `http://<host>:8000/v1`), the model `mlx-community/parakeet-tdt-0.6b-v3`, and the same key.

## Troubleshooting

- **The microphone button is unavailable:** transcription is turned off or not set up on the server.
- **Recording doesn't start:** check that OpenTeam has microphone permission in your device's settings.
- **No speech was detected:** check the selected microphone, mute control, and input volume. Your system’s sound settings show whether the input meter moves while you speak.
- **Transcription fails:** choose **Test connection** in **Settings → Voice notes** (or **Test saved connection** in `openteam model`), then try a short recording. A note that fails isn't sent. On iPhone, the recording is kept so you can send it again or discard it; on desktop, choose **Retry transcription**.
