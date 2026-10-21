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

The first time you sign in, the app asks you to connect a model. Choose a provider, sign in or paste your API key, and the app picks a model and sends it a short test message.

To connect or switch providers later, open **Settings → Model** on desktop or iPhone. Choose a provider, then **Sign in** or **Add API key**.

- **ChatGPT and Claude:** the sign-in page opens in your browser. When you finish, the app connects on its own. If another app is using the sign-in's return address on your computer, copy the address your browser lands on and paste it into the app. On iPhone, ChatGPT shows a code to enter on its sign-in page instead.
- **API keys:** paste the key when the app asks for it.

On a server without a screen, you can also sign in on the host with `openteam provider login <provider>`. If you've already signed in to Codex or Claude Code there, `openteam provider login` can reuse that sign-in.

## Choose a model

In **Settings → Model**, pick a model and reasoning effort, and choose **Apply**. The app saves your choice, then sends a short test message to check that the model works. Or run `openteam model` on the host for an interactive picker.

All bots use the same model. Changes apply to new messages; a task that's already running finishes with the settings it started with.

New installations have no saved model. After connecting a provider, the model picker defaults to the first available model in its catalog. Save or apply the selection to use it for new tasks. Existing saved model choices are preserved, even when the provider changes its catalog order.

Higher reasoning effort can give better results on hard tasks, but it's slower and uses more of your quota. New installations start at medium. Some models don't support reasoning effort, and the setting is unavailable for them.

To script the change:

```sh
openteam model list
openteam model use <provider> <model> --thinking medium
```

## Use OpenRouter

Choose **OpenRouter** and paste your API key. The model list shows the models your OpenRouter account allows that support tool use. OpenRouter model IDs include the model's author, such as `author/model-name`. Until you save a model, the picker starts on the Auto Router (`openrouter/auto`), which chooses a model for each request. If your account doesn't list it, the picker starts on a current general model instead.

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

Choose **Test** in **Settings → Model** to send a short message to your model and see whether it replies. On the host, `openteam doctor` runs the same kind of check. A model can appear in the list and still fail if your account has no quota left.

If no model is connected, or the connection stops working, the app shows a warning with a shortcut to these settings. Bots can't reply until you fix it.

If your sign-in expires, choose **Disconnect** and connect again in **Settings → Model**, or run `openteam provider login`.

Web search and voice transcription use their own credentials. See [web search](web-search.md) and [voice notes](transcription.md).
