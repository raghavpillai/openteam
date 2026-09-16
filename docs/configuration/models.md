# Model providers

The model provider supplies the intelligence your bots use. Connect one during setup or change it later in **Settings → Server**.

## Connect a provider

| Option | Use it with |
| --- | --- |
| ChatGPT sign-in (`openai-codex`) | A supported account sign-in offered by setup |
| OpenAI (`openai`) | An OpenAI API key |
| Anthropic (`anthropic`) | A supported Claude sign-in or Anthropic API key |
| Custom endpoint | A compatible hosted or local model service |

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

If sign-in expires, reconnect through Server settings or `openteam provider login`. Search and voice notes have [separate credentials](web-search.md); connecting a chat model does not configure those services.
