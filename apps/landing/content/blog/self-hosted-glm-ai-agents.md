---
title: "Revolut cut AI coding costs 90% with self-hosted GLM. What to copy"
seoTitle: "Self-hosted GLM-5.3 for AI agents: Revolut's math vs yours"
description: Revolut says self-hosted GLM cut its AI coding bill 90%. We ran GLM-5.3 in OpenTeam, a self-hosted AI agent app, and did the GPU math for a small team.
date: 2026-11-03
category: Guides
image: /blog/images/glm-5-3-api-vs-self-hosted-monthly-cost.png
imageAlt: Bar chart comparing a month of GLM-5.3 through an API at 1,000, 10,000 and 100,000 tasks with renting an eight-GPU H200 node, above a box working out what Revolut's 56 B200s cost at rental prices
related: ai-agents-local-models, gpt-6-1-terra-vs-sol-ai-agents, self-host-ai-agents
---

**Copy the model choice, not the GPU cluster. Revolut serves about 2,000 engineers from 56 Nvidia B200s; the GLM-5.3 setups vLLM documents use eight data-center GPUs, about $23,000 a month to rent. Through an API, GLM-5.3 passed our six agent tasks in OpenTeam, an open-source app for self-hosted AI agents, for $0.10 each.**

We build OpenTeam, so weigh our view accordingly. Revolut's numbers come from its own talk at AI Engineer NYC and The Register's report of it; nobody outside Revolut has checked them. For this post we ran GLM-5.3 and GPT-6.1 Sol through the same six bot tasks on one OpenTeam server. We didn't self-host GLM, so the hardware and cost sections use Z.ai's model cards, vLLM's recipes and published GPU prices.

## What Revolut did

David Abitbol, who leads AI operations at Revolut, described the move in a 15-minute talk, "[Shipping like a startup, regulated like a bank](https://ai.engineer/nyc/2026/talks/revolut)," on October 13 ([recording](https://www.youtube.com/watch?v=akEqiXFo3GM&t=20214s), [transcript](https://ai.engineer/reading/nyc-2026/transcripts/david-abitbol-revolut.md)). The [Register's write-up](https://www.theregister.com/ai-and-ml/2026/11/03/british-fintech-revolut-slashes-ai-coding-costs-10x-by-cutting-out-claude-and-going-self-hosted/5307345) on November 3 adds a few details. The short version:

- **Where it started.** Gemini went in first, in early 2025. Claude Code launched widely in January, with strict budgets, because "we were seeing engineers spend a thousand a month, 10,000 a month with not so much ROI."
- **The switch.** From around April, Revolut self-hosted GLM-5.1, and it now serves GLM-5.3. "To serve 2,000 engineers, we roughly need 56 B200," Abitbol said. The Register describes that as equivalent to seven eight-GPU DGX B200 systems.
- **The cost.** "Our blended cost of token is 30 cents per million. And so our invoice is one-tenth of what we were spending on Anthropic and OpenAI." The Register calls it a cut of "roughly 90 percent" in AI coding inference costs in under a year.
- **The speed targets.** Time to first token under 3 seconds ("as soon as you exceed 5 seconds, my Slack inbox starts to blow up") and about 200 tokens per second.
- **The tuning.** On the same number of GPUs, Revolut says performance improved 88% while demand rose 76% between April and August, with time to first token falling from over 10 seconds to about 1.6. Abitbol credits settings such as 4-bit weights on Blackwell GPUs, eight GPUs per copy instead of four for more KV cache, and a 256,000-token context: "long context is a scam."
- **What stayed.** GLM is text-only, so a router sends image work to other models. Codex and Claude Code are still there, but "the frontier is the exception."

Revolut also reports 60% faster coding time and 70% faster lead time on a sample of 2,000 engineers. Those are its own figures from a chart in the talk, with no published method.

## What the $0.30 leaves out

The talk doesn't say what "blended" means: an average of input and output prices, or a cost that includes cached tokens. It also doesn't say whether the $0.30 covers GPU rent or purchase, power or the people who run the cluster. On the [Hacker News thread](https://news.ycombinator.com/item?id=50350004) the same day, those questions came up within hours. One commenter estimated the rent at $250,000 to $300,000 a month from Together AI's prices. Another asked what happens to the hardware's value when Nvidia ships its next GPU, and a third reported correctness problems running GLM with long contexts on vLLM.

Here is our own version of that math. Together AI lists B200s at $6.79 per GPU-hour on a three-to-six-month reservation ([pricing](https://www.together.ai/pricing), read for this post). Fifty-six of them for a month is about $277,600. At $0.30 per million tokens, that bill needs about 925 billion tokens a month, or about 460 million per engineer.

That isn't absurd for coding agents, which reread long cached contexts on every step. But it only works with the GPUs busy most of the day. Revolut says engineers who log in after 5 p.m. get about 800 tokens per second, which also tells you the cluster has spare capacity in the evening. Half the traffic on the same GPUs would double the cost per token.

There's a second kind of risk in serving it yourself. On October 26, [Cloudflare disclosed](https://blog.cloudflare.com/kv-cache-exposure-remediation/) that its hosted GLM-5.3 sent 155 responses containing data from other customers' requests between August 27 and September 9. A cache pool sized for 681,280 tokens met a 1,048,576-token context limit and an SGLang bug. Cloudflare recommends that "all operators update SGLang dependencies to v0.5.22 or later."

## GLM-5.3 vs GPT-6.1 Sol on six agent tasks

We gave both models the same six tasks, each in a fresh bot with an identical prompt: a login and scrape, research with official links, a data job with a chart, a routine with a Test run, and two coding tasks checked by hidden tests. Both ran at medium reasoning through OpenRouter's API, and costs are what OpenRouter billed for every call. [Our Terra vs Sol comparison](/blog/gpt-6-1-terra-vs-sol-ai-agents) has the full method.

![A results table for six agent tasks run by GLM-5.3 and GPT-6.1 Sol, each cell with a score, busy time and billed cost, with GLM-5.3 at $0.097 and 45 seconds a task and Sol at $0.221 and 2.2 minutes](/blog/images/glm-5-3-vs-sol-agent-scorecard.png "GLM-5.3 passed all six tasks in a third of Sol's time, with one missed hidden check and a thin digest. Diagram: OpenTeam.")

### Where GLM-5.3 matched Sol

GLM-5.3 got the same answers as Sol on four of six tasks: all nine quotes with their tags, the three release facts with official links, the dataset's three numbers to the decimal, and 48 of 48 hidden checks on the hard coding task.

It worked differently. GLM never started a helper, the second agent an OpenTeam bot can hand work to, and made about 9 tool calls a task to Sol's 23. On the login task it skipped the browser altogether. It signed in with `curl`, found the quotes as JSON inside each page, and parsed them with Python. That works on this practice site, which ships its data in the page.

The result was speed: 45 seconds of busy time per task, against Sol's 2.2 minutes.

### Where it fell short

- **One hidden check.** On the duration parser, GLM accepted `2:03`. The spec lists `2:03` as an input that must raise an error, because minutes in clock format need two digits. It passed 77 of 78.
- **A thin digest.** Its Hacker News routine was set up correctly, but the Test run listed two stories with no discussion links, where Sol listed six with links. It also described one research system as "a new model," which it isn't. Both stories were on topic, so it scored well under our rubric anyway.

### The cost wasn't the headline price

GLM-5.3 cost $0.097 a task, against Sol's $0.221: 2.3 times cheaper, not the 28 times that OpenRouter's headline input prices ($0.07 against $2) suggest.

OpenRouter [lists GLM-5.3 at 47 endpoints from 36 hosts](https://openrouter.ai/z-ai/glm-5.3/providers), with input prices from $0.07 to $2.80 per million tokens, and most of the cheapest report 4-bit weights. It sent 44 of our 50 calls to Together at $1.40 input and $4.40 output, the same as [Z.ai's own price](https://docs.z.ai/guides/overview/pricing).

### What text-only means in OpenTeam

GLM-5.3 reads text only. In OpenTeam, the helper that drives a bot's desktop and browser needs a model that can see screenshots, and it won't start on a text-only model. One model serves every bot on a server, so there's no router to hand screenshots to a vision model, as Revolut does.

On our tasks that didn't matter, because GLM found routes through the terminal and the page reader. A site that only works in a real browser, or a task that needs the bot to look at its screen, would. [GLM-5.3-Flash](https://huggingface.co/zai-org/GLM-5.3-Flash) takes images; we didn't test it.

## What self-hosting GLM-5.3 takes

[GLM-5.3](https://huggingface.co/zai-org/GLM-5.3) has about 753 billion parameters, published in 8-bit (FP8) form, so the weights alone are about 750 GB. Z.ai says it uses the same base model as GLM-5.2, with "every gain" from post-training. Its card lists SGLang, vLLM, Transformers, KTransformers and Unsloth for serving. Abitbol said GLM fits on four GPUs, but that eight leave enough room for the KV cache.

[vLLM's recipe](https://recipes.vllm.ai/zai-org/GLM-5.3) gives the hardware:

| Setup | Hardware | Notes |
|---|---|---|
| FP8, the default | One node with 8 H200 or 8 H20 GPUs | "Fits on a single 8xH200 / 8xH20 node" |
| FP8, full 1M context | 8 B200 GPUs (180 GB each) | FP8 KV cache |
| 4-bit (NVFP4) | Blackwell, B200 or B300 | Checkpoint about 465 GB |
| BF16 | Several nodes | Twice the memory of FP8 |

The smaller options:

- **[GLM-5.3-Flash](https://huggingface.co/zai-org/GLM-5.3-Flash)** has 320 billion parameters with 18 billion active per token, takes images, and is MIT-licensed. Its FP8 weights are about 306 GiB, and [vLLM's recipe](https://recipes.vllm.ai/zai-org/GLM-5.3-Flash) runs it on four to eight data-center GPUs.
- **[GLM-4.7-Flash](https://huggingface.co/zai-org/GLM-4.7-Flash)**, from January, is a 30-billion-parameter model with 3 billion active. It's small enough for one workstation GPU or a Mac with plenty of memory, as in our [guide to local models](/blog/ai-agents-local-models). It's text-only, and we didn't test it on these tasks.

GLM-5.3's [license](https://huggingface.co/zai-org/GLM-5.3/blob/main/LICENSE) is MIT-style with one added condition. A company selling model access as a service with over $10 billion in yearly revenue must pass Z.ai's security review before commercial use. That won't affect a small team.

## The math for a small team

At the $0.097 a task we were billed, 1,000 bot tasks a month cost about $97 through an API. A rented node with eight H200s costs $23,302 a month at Together AI's 91-to-180-day price of $3.99 per GPU-hour, or $34,982 on demand at $5.99. The node pays off only past about 240,000 tasks a month, before anyone's time to run it.

![Bar chart: GLM-5.3 through an API costs $97 for 1,000 tasks, $970 for 10,000 and $9,700 for 100,000 a month, against $23,302 and $34,982 for a rented node with eight H200 GPUs; a box below works Revolut's 56 B200s out to $277,600 a month and 925 billion tokens](/blog/images/glm-5-3-api-vs-self-hosted-monthly-cost.png "At small-team volumes the API wins by two orders of magnitude. GPU prices from Together AI's GPU Clusters page. Diagram: OpenTeam.")

Renting only for office hours, about 220 hours a month, still costs about $10,500 on demand, or roughly 109,000 tasks' worth. And our tasks were short: a bot that rereads a large codebase all day burns far more tokens per task, which moves the line.

Self-hosting makes sense when one of three things is true. Your prompts and files can't leave machines you control. You can keep eight GPUs busy most of the day. Or you already own the hardware. Otherwise the API is cheaper, and the model is the same.

![A decision flow with three questions: must data stay on machines you control, would you keep eight GPUs busy, and can someone run an inference server, leading to use an API, self-host GLM-5.3, or rent a dedicated deployment or go smaller, with an amber note that GLM-5.3 is text-only](/blog/images/self-host-glm-decision.png "Most small teams stop at the second question. Diagram: OpenTeam.")

## How to point OpenTeam at GLM

**Through OpenRouter.** Choose OpenRouter in **Settings → Model**, pick `z-ai/glm-5.3`, and choose **Apply**. Or on the server host:

```sh
openteam model use openrouter z-ai/glm-5.3 --thinking medium
```

OpenRouter picks the host for each call, which is why our bill didn't match the headline price.

**Your own vLLM server.** Start GLM-5.3 with tool calling on; OpenTeam's bots can't work without it. This is vLLM's H200 command without its speculative-decoding flags, with a 256K context and an API key added:

```sh
VLLM_USE_RUST_FRONTEND=1 vllm serve zai-org/GLM-5.3 \
  --tokenizer-mode glm5_next --kv-cache-dtype fp8 \
  --tensor-parallel-size 8 --max-model-len 262144 \
  --tool-call-parser glm47 --reasoning-parser glm47 \
  --enable-auto-tool-choice --served-model-name glm-5.3 \
  --api-key "$VLLM_API_KEY"
```

Then add it on the OpenTeam host. The CLI asks for the key ([models](/docs/configuration/models)):

```sh
openteam provider add glm --name "GLM-5.3" \
  --base-url http://gpu-node.internal:8000/v1 \
  --api openai-completions \
  --model glm-5.3 --context-window 262144 --reasoning
openteam model list glm
openteam model use glm glm-5.3
```

Three details matter:

- **Reachability.** The bots' computer runs in Docker, so `localhost` means the container. Use an address the container can reach.
- **Context window.** OpenTeam assumes 128,000 tokens for a custom model unless you say otherwise, and summarizes long chats at about 90% of the window it believes in. Set `--context-window` to what the server really serves.
- **Reasoning effort.** Z.ai's card says GLM-5.3 accepts low, high and max, and treats anything else as max. Try the levels OpenTeam offers with **Test** in **Settings → Model** before you settle on one.

OpenTeam treats a custom endpoint's model as text-only unless the endpoint's model list says it takes images, which matters if you serve GLM-5.3-Flash yourself. Any other OpenAI-compatible host works the same way, as long as it lists its models.

## What a small team can copy from Revolut

1. **An open-weights model as the default, a frontier model as the exception.** In OpenTeam one model serves every bot, so the exception means switching the server's model in **Settings → Model** for a hard job. The change applies to new messages.
2. **A shorter context.** Revolut found 256K enough. A smaller window means fewer tokens reread on every step and a smaller server; on a custom endpoint, `--context-window` sets where OpenTeam summarizes.
3. **A person on the sends.** Revolut treats its coding agents as human-in-the-loop tools, with sandbox rules for what they may run, and says that reassures its regulator. In OpenTeam, email and texts from your Mac go through cards you approve, and bots are told to draft Slack posts the same way. Nothing else asks first, so decide what bots may touch.
4. **Speed targets.** Revolut's line is 3 seconds to the first token. In our local-models test, a new OpenTeam chat's first request carried about 22,000 tokens, so a slow server shows up fast.
5. **A deliberate choice of where inference runs.** Abitbol's point on Chinese open-weight models was that the weights are fine; the question is which endpoint you send data to. Pick a host and region on purpose, or run it yourself.

OpenTeam's limits apply either way: one model per server, one human account, desktop apps for macOS on Apple silicon and Linux x64, and an iPhone beta.

## Frequently asked questions

### Did Revolut really cut its AI costs by 90%?

That's Revolut's own figure, for AI coding inference, and nobody outside the company has checked it. Abitbol said self-hosted GLM costs a blended $0.30 per million tokens and that the invoice is a tenth of what Revolut paid Anthropic and OpenAI. He didn't say what the $0.30 includes.

### What hardware do you need to self-host GLM-5.3?

One node with eight H200 or eight B200 GPUs, running the FP8 weights, in vLLM's recipes. vLLM documents the full 1M-token context on eight B200s, and a 4-bit checkpoint of about 465 GB for Blackwell GPUs. It doesn't fit on one GPU.

### Is GLM-5.3 good enough for AI agents?

For text work, yes in our test. It passed all six tasks with one missed hidden check and a thin digest, in a third of Sol's time. It can't read images, so in OpenTeam it can't use the helper that drives a bot's browser and desktop.

### How much does GLM-5.3 cost through an API?

Z.ai charges $1.40 per million input tokens and $4.40 output. OpenRouter lists hosts from $0.07 input, most of the cheapest serving 4-bit weights, but routed most of our calls to a $1.40 host. Our bot tasks averaged $0.097 each.

### Can OpenTeam use a self-hosted GLM model?

Yes. Serve it from vLLM or SGLang with tool calling on, add it with `openteam provider add`, and choose it in **Settings → Model**. All bots on the server then use it.

### Is GLM-5.3 open source?

Its weights are open under a permissive MIT-style license with one condition for very large model-hosting companies. GLM-5.3-Flash and GLM-4.7-Flash are MIT-licensed.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, or follow the [quickstart](/docs/getting-started/quickstart) for Windows. Then choose GLM-5.3 through OpenRouter or your own endpoint, and get the apps from the [download page](/download).
