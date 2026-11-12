---
title: "Run self-hosted AI agents on local models: Ollama, LM Studio, vLLM"
seoTitle: "Ollama AI agents: run self-hosted bots on a local model"
description: OpenTeam's self-hosted AI agents can run on Ollama, LM Studio or vLLM. We ran it on a 24 GB Mac: setup, context windows, timing and what stays local.
date: 2026-10-23
category: Guides
image: /blog/images/openteam-local-models-settings.png
imageAlt: OpenTeam's Model settings with Ollama as the provider, the model qwen3.5-agent:latest, reasoning effort Off, and Test and Apply buttons
related: self-host-ai-agents, ai-agent-own-computer, best-self-hosted-ai-agents
---

**Yes. OpenTeam, a team of self-hosted AI agents, can run every bot on a local model served by Ollama, LM Studio or vLLM through their OpenAI-compatible APIs. You add the endpoint once on the host and choose it in the app. Give the model a context window of 64,000 tokens or more, since a new chat's first request carries about 22,000 tokens.**

We build OpenTeam (GPL-3.0), so weigh our view accordingly. On October 21, 2026, we connected a test OpenTeam server to Ollama on a Mac mini with an M4 Pro and 24 GB of memory, and ran real bot turns with Qwen 3.5 4B. The LM Studio and vLLM steps come from their documentation and OpenTeam's code; we didn't run them.

## What we saw on a 24 GB Mac

The Mac was also running other Docker workloads during the test. Times are wall-clock from sending a message to the bot finishing.

| Test | Qwen 3.5 4B on Ollama, 64K context |
|---|---|
| App's model test | Passed in 27 s |
| First request of a new chat, about 22,000 tokens | First token after 65 s |
| Next steps in the same chat | Usually 6–17 s each |
| Plain question | Answered in 15 s |
| Free disk space via the shell | Right answer in 105 s |
| Write a file, read it back | Right answer in 66 s |

The 4B model answered a plain question, checked free disk space through the shell, and wrote a file and read it back, each correctly. It generated about 30 tokens a second.

## What you need

- **An OpenTeam server** in Docker, with your account created ([quickstart](/docs/getting-started/quickstart), [self-hosting guide](/blog/self-host-ai-agents)). The server wants about 8 GB of memory on its own.
- **A model server** that speaks the OpenAI Chat Completions API, such as Ollama, LM Studio or vLLM.
- **A model with tool calling.** Bots act by calling tools. A chat-only model can answer in words and do nothing else.
- **A context window of 64,000 tokens or more.** Ollama's own docs say agents and coding tools "should be set to at least 64000 tokens" ([context length](https://docs.ollama.com/context-length)).
- **Memory for both.** The model's weights and context cache sit beside OpenTeam's containers.

These are the sizes `ollama ps` reported on our Mac:

| Model | Download | In memory, as loaded |
|---|---|---|
| `qwen3.5:4b` with a 64K context | 3.3 GB | 4.2 GB |
| `qwen3.5:9b-mlx` with a 4K or 32K context | 8.9 GB | 9.0–9.3 GB |

The 4B model fits beside OpenTeam on 24 GB with room to spare. By the same arithmetic, start with a 4B model on 16 GB, and plan on 32 GB or more for a 9B model. Bigger models want a GPU server or a Mac with 64 GB or more. We didn't test those machines.

## Step 1: Serve a model with a large context window

### Ollama

Pull a model whose library page lists **tools**, then give it a larger context. Ollama sets the default context from available memory: under 24 GiB of VRAM it's 4,096 tokens ([context length](https://docs.ollama.com/context-length)). On our Mac, with 17.8 GiB of usable GPU memory, Ollama logged `default_num_ctx=4096`. That's a fifth of OpenTeam's first request.

The cleanest fix is a model variant with its own context setting:

```sh
ollama pull qwen3.5:4b
printf 'FROM qwen3.5:4b\nPARAMETER num_ctx 65536\n' > Modelfile
ollama create qwen3.5-agent -f Modelfile
```

Or raise the default for every model by starting the server with `OLLAMA_CONTEXT_LENGTH=64000 ollama serve`, as Ollama's docs show. After the first message, run `ollama ps` and check the **CONTEXT** column. Ours read `65536`.

Next, make sure the bots' computer can reach Ollama. OpenTeam runs in Docker, where `localhost` means the container. On a Mac with Docker Desktop, `host.docker.internal` reaches a server listening on the host's `127.0.0.1`, which is Ollama's default; we checked this from inside the bots' computer. On Linux, Ollama must listen on more than `127.0.0.1`: OpenTeam's docs say to set `OLLAMA_HOST=0.0.0.0` ([models](/docs/configuration/models)); then firewall port 11434 so only the host and its containers reach it. If you've already pointed `OLLAMA_HOST` at one address, use that address instead.

### LM Studio

LM Studio's server uses `http://localhost:1234/v1` in its examples, and it binds to `127.0.0.1` unless you pass `--bind` ([server](https://lmstudio.ai/docs/cli/server-start), [OpenAI compatibility](https://lmstudio.ai/docs/developer/openai-compat)). Load the model with a context length that fits OpenTeam's prompt ([load](https://lmstudio.ai/docs/cli/load)):

```sh
lms load <model-key> --context-length 65536
lms server start
```

On a Linux host, add `--bind 0.0.0.0` so Docker can reach the server. LM Studio warns that any other bind exposes it beyond your machine, so keep that port off the internet.

### vLLM

vLLM listens on port 8000. It only returns tool calls when you start it with `--enable-auto-tool-choice` and a parser for your model family ([tool calling](https://docs.vllm.ai/en/latest/features/tool_calling.html), [serve options](https://docs.vllm.ai/en/latest/cli/serve.html)):

```sh
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --max-model-len 65536
```

vLLM's docs pair `hermes` with Qwen 2.5, `llama3_json` with Llama 3.1 and 3.2, `mistral` with Mistral and `openai` with gpt-oss. If you start it with `--api-key`, leave `--no-auth` out of the next step, and OpenTeam asks for the key.

## Step 2: Add the endpoint on the OpenTeam host

You add a custom endpoint on the server host with the `openteam` command, then choose it in the app:

```sh
openteam provider add ollama --name "Ollama" \
  --base-url http://host.docker.internal:11434/v1 \
  --api openai-completions --no-auth \
  --model qwen3.5-agent:latest --context-window 65536
openteam model list ollama
```

For LM Studio, use port `1234`; for vLLM, `8000`. Three details matter:

- **Tell OpenTeam the context window** with `--context-window`. OpenTeam starts summarizing a conversation at 90% of the window, so this keeps long chats inside your model's real limit. Ollama's model list doesn't report a window, so without the flag OpenTeam assumes 128,000 tokens, and up to 16,384 output tokens.
- **Use the model ID exactly as the endpoint lists it,** tag included. Ollama lists our variant as `qwen3.5-agent:latest`. Check the window afterwards in `openteam model list ollama`.
- **One model gets the extra settings.** Other models from the same endpoint still appear, with the defaults.

The `--api` option also accepts `openai-responses`, `anthropic-messages` and `google-generative-ai`, for servers that speak those formats.

## Step 3: Choose the model in the app

On a new server, the app's first-run setup asks you to choose your bots' AI. Endpoints you added with `openteam provider add` appear under **More providers**, labeled "OpenAI-compatible endpoints". On a server that's already set up, open **Settings → Model** on desktop or iPhone. Choose the provider and model, then **Apply**. The app saves the choice and sends a short test message.

![OpenTeam's Model settings with Ollama as the provider, the model qwen3.5-agent:latest, reasoning effort Off, and Test and Apply buttons](/blog/images/openteam-local-models-settings.png "The Model settings on the desktop app, pointed at Ollama. Captured from our test server. Image: OpenTeam.")

The model serves every bot, for its own work and for background jobs such as conversation summaries, so those stay on your machine too. A change applies to new messages.

## Speed and timing

Two timers matter on a local machine:

1. **The app's model test allows 60 seconds.** It asks for the single word "OK", and our 4B model passed in 27 seconds. Agent requests get a longer limit, so on a slower machine, send one real message as well.
2. **Each model request has 5 minutes to send its first byte.** While Ollama reads a prompt, it sends nothing back, so the first request of a new chat, about 22,000 tokens of instructions and tool definitions, has 5 minutes to start replying. Our 4B model started in 65 seconds.

After that first request, Ollama reuses its cache of the prompt's start, and later steps in the same chat began in 3 to 9 seconds. A bot that comes back to a chat after the cache is gone reads the full prompt again.

Endpoint models get one reasoning level, **Off**, which sends no setting, so the model's own default applies; Qwen 3.5 on Ollama thinks by default. Adding the endpoint with `--reasoning` adds the higher levels.

## What stays on your hardware

With a local model, every model request stays on your machines, including the background memory and summary calls. Your conversations, files and memory already live on the OpenTeam server ([privacy](/docs/configuration/privacy)).

Tools that reach the internet still do:

- **Web search** goes to the search provider you choose, if any. Search was off on our test server.
- **Web fetch** with the built-in fetcher goes straight from your server to the site.
- **Plugins** talk to their services, such as Gmail or GitHub.
- **Voice notes** go to your transcription provider. It can be a custom OpenAI-compatible service, such as a transcription server you run.

## Troubleshooting

- **"Inference exceeded its time limit" on Test.** The model took more than 60 seconds to say "OK". It may still be loading or thinking. Send one real message, or try a smaller model.
- **A bot shows "Thinking" for minutes, then fails.** The first request took longer than 5 minutes to start replying. Use a smaller model or a shorter context, free memory, or move the model to a faster machine.
- **Connection refused at `host.docker.internal`.** The model server listens only on another address. Check `OLLAMA_HOST`, or LM Studio's `--bind`, and use the address it really listens on.
- **The model list shows 128,000 tokens.** The `--model` value didn't match the endpoint's ID. Copy it from `openteam model list <provider>`, tag included. Switch to another provider, remove this one with `openteam provider remove <id>`, and add it again.

## Frequently asked questions

### Can I run OpenTeam with Ollama?

Yes. Add Ollama's OpenAI-compatible endpoint with `openteam provider add`, give the model at least a 64K context, and choose it in the app. We ran real bot turns this way on a 24 GB Mac.

### What's the best local model for AI agents?

The biggest tool-calling model your machine can run with a 64K context that still reads a 22,000-token prompt within a few minutes. On our 24 GB Mac, Qwen 3.5 4B read it in 65 seconds. More memory buys a bigger model.

### How much RAM do I need to run AI agents locally?

About 8 GB for OpenTeam plus the model's loaded size. Our 4B model used 4.2 GB with a 64K context, and the 9B used 9 to 9.3 GB. Plan on 16 GB as a floor and 32 GB for a 9B model.

### Can I switch between a local and a hosted model?

Yes. Choose another provider and model in **Settings → Model** on desktop or iPhone, then **Apply**. The change applies to new messages, for every bot and background job.

### Which local model servers work with OpenTeam?

Any server that speaks the OpenAI Chat Completions, OpenAI Responses, Anthropic Messages or Google Generative AI API, and serves a model with tool calling. That includes Ollama, LM Studio and vLLM; we ran our test on Ollama.

### Is a local LLM agent completely private?

The model requests are. Searches, fetched pages, plugins and voice notes still reach their services, unless you turn them off or run those services yourself.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, then follow the [quickstart](/docs/getting-started/quickstart). The [models guide](/docs/configuration/models) covers custom endpoints, and the desktop and iPhone apps are on the [download page](/download).
