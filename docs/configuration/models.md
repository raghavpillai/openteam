# Model providers

Your bots use an AI model from a provider you connect. Use a subscription you already have, an API key, or your own model server.

## Choose a provider

| Provider | What you need | CLI ID |
| --- | --- | --- |
| Codex | A ChatGPT subscription | `openai-codex` |
| Claude Code | A Claude subscription | `claude-code` |
| OpenAI | An OpenAI API key | `openai` |
| Anthropic | An Anthropic API key | `anthropic` |
| OpenRouter | An OpenRouter API key | `openrouter` |
| Custom endpoint | A compatible model server, hosted or local | Your choice |

Usage and billing go through your provider account. A subscription sign-in and an API key from the same company are separate connections.

## Connect a provider

In the desktop app, open **Settings → Server → Provider connection**, choose a provider, and connect.

Or, on the server host, run guided setup:

```sh
openteam setup
```

If you've already signed in to Codex or Claude Code on the host, setup can reuse that sign-in.

## Choose a model

In the desktop app, open **Settings → Server → Model and reasoning**, pick a model and reasoning effort, and choose **Apply**. Or run `openteam model` on the host for an interactive picker.

All bots use the same model. Changes apply to new messages; a task that's already running finishes with the settings it started with.

Higher reasoning effort can give better results on hard tasks, but it's slower and uses more of your quota. New installations start at medium. Some models don't support reasoning effort, and the setting is unavailable for them.

To script the change:

```sh
openteam model list
openteam model use <provider> <model> --thinking medium
```

## Use OpenRouter

Choose **OpenRouter** and paste your API key. The model list shows the models your OpenRouter account allows that support tool use. OpenRouter model IDs include the model's author, such as `author/model-name`.

## Use your own model server

You can connect any server that speaks one of these APIs: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, or Google Generative AI. Bots rely on tool calling, so choose a model that supports it.

The server must be reachable from the bots' computer, which runs in Docker. Inside Docker, `localhost` means the container, not your host. Use `host.docker.internal` to reach a server running on the host, such as [Ollama](https://ollama.com). On Linux, the server must listen on more than `127.0.0.1`; for Ollama, set `OLLAMA_HOST=0.0.0.0`.

```sh
openteam provider add local --name "Local models" \
  --base-url http://host.docker.internal:11434/v1 \
  --api openai-completions --no-auth
openteam model list local
openteam model
```

If your endpoint needs a key, leave out `--no-auth` and the CLI will ask for it. The `--api` option accepts `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`.

## Check the connection

Run `openteam doctor` to send a test request to your model. A model can appear in the list and still fail if your account has no quota left.

If your sign-in expires, choose **Disconnect** and connect again in **Settings → Server**, or run `openteam provider login`.

Web search and voice transcription use their own credentials. See [web search](web-search.md) and [voice notes](transcription.md).
