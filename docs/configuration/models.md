# Model providers

The model provider supplies the intelligence your bots use. Connect one during setup or change it later in **Settings → Server**.

## Connect a provider

| Option | Use it with |
| --- | --- |
| Codex (`openai-codex`) | A Codex/ChatGPT sign-in, including a reusable local Codex login |
| Claude Code (`claude-code`) | A Claude subscription sign-in, including a reusable local Claude Code login |
| OpenAI (`openai`) | An OpenAI API key |
| Anthropic (`anthropic`) | An Anthropic API key |
| OpenRouter (`openrouter`) | An OpenRouter API key |
| Custom endpoint | A compatible hosted or local model service |

Codex and Claude Code have separate credentials and catalogs from OpenAI and Anthropic API access. They reuse vendor sign-ins; inference still runs through Pi, without launching either CLI. Connecting an API key does not replace a subscription sign-in.

Follow the app's connection flow or run:

```sh
openteam setup
```

Enter credentials in the app or hidden CLI prompt. Setup can reuse a compatible local sign-in when it detects one. Account access, quota, and billing come from the provider you connect.

## Select a model

Choose a model from the connected provider's list and apply it. On the command line:

```sh
openteam model
```

The interactive editor lets you select the provider, model, and reasoning level. Fresh installations start with the recommended model and medium reasoning. If a model does not support reasoning controls, that setting is disabled.

All bots share the saved selection. Changes apply to new turns; work already running keeps the settings it started with.

For scripting:

```sh
openteam model list
openteam model use <provider> <model> --thinking medium
```

## Add a custom endpoint

Use an endpoint reachable from the **bot computer container**. Its `localhost` is the container itself, not your laptop.

For an unauthenticated OpenAI-compatible service on the host:

```sh
openteam provider add local --name "Local models" \
  --base-url http://host.docker.internal:11434/v1 \
  --api openai-completions --no-auth
openteam model list local
openteam model
```

Use a reachable host address if your Docker environment does not provide `host.docker.internal`. Omit `--no-auth` when the endpoint needs a key; the CLI prompts for it.

Supported adapters include `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`. Model discovery must work before a model can be selected.

## Check the connection

Run `openteam doctor` to test an actual model request. A model appearing in the list does not guarantee quota or support for every tool.

If sign-in expires, reconnect through Server settings or `openteam provider login`. [Web search](web-search.md) and [voice notes](transcription.md) have separate credentials.

## OpenRouter

Choose **OpenRouter** in setup or Server settings and enter its API key in the hidden prompt. No base URL is required. The model picker discovers models permitted by your OpenRouter account settings and includes text-output models advertising tool support. It reads reasoning, image-input support, context limits and pricing from the provider catalog.

```sh
openteam provider login openrouter --auth api-key
openteam model list openrouter
openteam model
```

During quick setup, OpenRouter selects the first supported model returned by your account catalog. Use `openteam model` to change it. Namespaced IDs stay intact: the provider is `openrouter` and the model ID includes its author, for example `author/model-name`. Requests and billing stay with OpenRouter.

Existing Anthropic OAuth credentials move to Claude Code on runtime startup, along with a root model selection using that credential. Anthropic API keys remain with Anthropic. Explicit task profiles or saved sessions referring to the old `anthropic` subscription identity should be updated to `claude-code`; they are not silently routed through another provider.
