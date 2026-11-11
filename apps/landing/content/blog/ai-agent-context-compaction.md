---
title: "Why long AI agent tasks cost more, and how compaction caps it"
seoTitle: "AI agent context compaction: why long tasks cost more"
description: Each model call resends the whole conversation, so every step of a long agent task costs more. How OpenTeam's compaction works, with a measured run.
date: 2026-11-08
category: Engineering
image: /blog/images/compaction-prompt-growth-run.png
imageAlt: A bar chart of one long agent task, with the prompt sent on each model call growing toward the 829,800-token compaction threshold, a drop after the summary, and cumulative cost at OpenRouter's listed prices
related: ai-agent-memory, ai-agent-own-computer, how-ai-agents-talk-to-each-other
---

**A model keeps nothing between calls, so an agent resends the whole conversation on every step, and each step costs more than the last. Prompt caching makes the resent part 20 times cheaper. Compaction caps the size by swapping the history for a summary. OpenTeam, our open-source app for self-hosted AI agents, does it at 90% of the model's prompt limit.**

We build OpenTeam, so read this as a practitioner's account. We build the design up from the simplest loop to what OpenTeam does now, one idea per step; the version numbers exist only for this post. Every number comes from the code or from one long task we ran for this post on a local OpenTeam server, with GPT-6.1 Sol through OpenRouter.

## Why long agent tasks get more expensive

NVIDIA's [post on agent memory](https://blogs.nvidia.com/blog/memory-full-stack-codesign/) describes the problem from the data center: "Agentic trajectories carry prior context across repeated model and tool calls," up to 3 million tokens in some cases. On the other side of the API, the same growth shows up as a bill. Every call sends the system prompt, the tool definitions and everything that has happened so far.

If each step adds about the same amount, step 100 sends a hundred times as much as step 1, and the whole task costs roughly the square of its length. To measure it, we asked a bot to read 287 of OpenTeam's own source files in full and review them. We told it not to hand the reading to helpers, which OpenTeam's bots do by default for long jobs, so one conversation had to hold everything.

![A bar chart of 218 model calls: the prompt grows from about 20,000 tokens to 910,475, crossing the 272,000 price step and the 829,800 threshold, then drops to 39,547 after the summary. Below, cumulative cost reaches $34.07 at listed prices.](/blog/images/compaction-prompt-growth-run.png "One conversation, call by call: each bar is the whole prompt one call sent. Diagram: OpenTeam.")

The first call sent 19,852 tokens. Call 179 sent 910,475, 46 times as much, and calls that large took a median 9.9 seconds against 4.1 under 100,000. Before the summary, the bot's 179 calls sent 81.4 million tokens, 95.7% of them billed as cache reads. At OpenRouter's listed prices that came to $32.05; without caching, the same calls would have listed at about $314.

## v0: resend everything

The simplest agent loop keeps the conversation in a list and sends the whole list on every call.

![Diagram of v0: every model call sends the system prompt, tools, your request and every call and result so far, with nothing summarized or dropped.](/blog/images/compaction-design-v0.png "v0: the whole conversation goes out on every call. Diagram: OpenTeam.")

**How it works.** Each call carries the system prompt, the tool definitions, your request, and every tool call and result so far. The model answers with another tool call, the result is appended, and the loop sends everything again.

**Pros.**

- The model sees every byte of the work, exactly as it happened.
- There's nothing to build, store or get wrong.

**Cons.**

- Every call pays again for every earlier token.
- The list only grows. When it passes the model's prompt limit, the provider refuses the call and the task stops.

## v1: cache the prefix

Providers bill a repeated prompt prefix as a cheap cache read, so keep the front of every request byte-identical.

![Diagram of v1: the same request, with everything but the newest result billed as a cache read at $0.10 per million tokens and the new part at $2.50.](/blog/images/compaction-design-v1.png "v1: an unchanged prefix is billed as a cache read. Diagram: OpenTeam.")

**How it works.** OpenRouter [lists](https://openrouter.ai/openai/gpt-6.1-sol) GPT-6.1 Sol at $2.50 per million tokens for a cache write and $0.10 for a cache read, a 25-to-1 ratio. The discount needs an unchanged prefix, so the rule is to append and never edit what's been sent. OpenTeam orders its system prompt "so per-turn changes sit late in the cached prefix," and freezes its platform sections until the next compaction. The tool catalog is pinned the same way, so a newly installed plugin is announced in a later message. Even a progress note is "persisted once," because the code says an ephemeral tail message "would move on every model call and invalidate the cached prefix."

**Pros.**

- A resent token costs a twenty-fifth of a new one.
- The model's input doesn't change, so neither do its answers.

**Cons.**

- The conversation still grows by every result, and still hits the limit.
- One changed byte near the start re-bills everything after it.

## v2: drop the oldest messages

When the next call wouldn't fit, cut messages from the front.

![Diagram of v2: the oldest messages, including your request, are dropped when the next call would not fit.](/blog/images/compaction-design-v2.png "v2: a sliding window forgets the task first. Diagram: OpenTeam.")

**How it works.** A sliding window keeps the system prompt and as many of the newest messages as fit. Nothing calls the model to do it.

**Pros.**

- The conversation stays bounded, with no extra model call.
- It's easy to reason about.

**Cons.**

- The first thing cut is your request, then the early decisions.
- A cut can separate a tool result from the call that produced it, and providers reject a result whose call is missing.

## v3: summarize at a threshold

Near the limit, ask the model to summarize the work so far, and start the next call from the summary.

![Diagram of v3: at 829,800 of 922,000 tokens the model writes a summary, and the next call sends your request word for word and then the summary.](/blog/images/compaction-design-v3.png "v3: a summary replaces the history at a threshold. Diagram: OpenTeam.")

**How it works.** The threshold is the lower of 90% of the prompt limit and the limit minus 10,000 tokens: 829,800 of 922,000 for GPT-6.1 Sol. The summary goes to the same model, with the bot's instructions and tool definitions. The request asks it to cover "the user's requests and especially corrections, constraints and preferences, what you've done so far, key decisions and their reasons," and what's left to do. It ends: "DO NOT call any tools." The next call sends your latest request word for word, then the summary.

**Pros.**

- The task and the progress survive.
- The conversation stays bounded at any length.

**Cons.**

- The bot stops while the summary is written, which is a model call over the whole conversation.
- Whatever the summary leaves out, an exact path, an ID, a number, is gone.

## v4: summarize in the background

Start the summary at the threshold, let the bot keep working, and swap it in when it's ready.

![Diagram of v4: the summary is written in the background from a snapshot, and the next call sends the request, the summary and everything since the snapshot.](/blog/images/compaction-design-v4.png "v4: the bot keeps working while the summary is written. Diagram: OpenTeam.")

**How it works.** The summary covers a snapshot of the conversation. When it comes back, OpenTeam checks that the conversation still starts with that snapshot and that the system prompt hasn't changed. Then it sends your request, the summary and every message added since the snapshot, verbatim, keeping each tool call beside its result. The bot only waits once it reaches the full limit or 85 images. A failed summary gets three attempts: shorter after an output-limit error, with fewer inputs after an input-limit error, and after a two-second pause on a rate limit.

**Pros.**

- No pause in the usual case.
- Nothing after the snapshot gets summarized.

**Cons.**

- What the summary drops is gone for good.
- The bot can't tell what it lost, so it can't go back for it.

## v5: keep the archive

Save what was summarized, and tell the bot where to look.

![Diagram of v5: the summary ends with a pointer to ReadTranscript and the open todo list, and the summarized messages are archived on disk.](/blog/images/compaction-design-v5.png "v5: nothing summarized is thrown away. Diagram: OpenTeam.")

**How it works.** Each compaction writes an archive on the bot computer: a manifest and a blob with the summary, the messages it replaced and the kept tail. It's staged first, so an interrupted swap can be recovered. The summary message points to ReadTranscript, a tool that pages back through the conversation and the bot's own tool calls, newest first. The open todo list and any skills you attached by hand ride along.

**Pros.**

- Exact details can be read back.
- The todo list survives the summary.

**Cons.**

- The summary call is itself a full-size request, and it can be refused.
- One huge tool result can push the conversation past the limit before any summary exists.

## v6: recover from an overflow

If the provider still refuses a request, summarize a flattened, size-capped copy and retry.

![Diagram of v6: after a context-length error, a flattened and size-capped transcript is summarized with no tools, then the request is retried.](/blog/images/compaction-design-v6.png "v6: a refused request turns into a summary and a retry. Diagram: OpenTeam.")

**How it works.** On a context-length error, OpenTeam renders the conversation as a plain transcript, with each tool call or result cut at 100,000 characters. The budget is three characters per token of the window left, at most 2.8 million characters: 2,664,000 for a 922,000-token limit. If that's still too long, every message gets a fair share and the longest are trimmed. The summary call runs with no tools and at most 32,000 output tokens, and your last request and what followed stay verbatim. Each retry halves, then thirds, the budget.

**Pros.**

- A refused request becomes a retry.
- The summary call can't run tools.

**Cons.**

- Fair-share trimming can cut any message, including one that mattered.
- Recovery costs a failed call plus a summary call.

## Where we ended up

Today's design is v6, with v1's cache rules throughout.

![Flow diagram: measure the prompt on each call, start a background summary at 829,800 tokens, archive and swap it in when ready, so the next call sends the system prompt and tools, user_info, your request, the summary with a transcript pointer, and everything since the snapshot. Notes cover overflow recovery and what a summary costs.](/blog/images/compaction-design-today.png "What happens on every model call. Diagram: OpenTeam.")

### When it starts

OpenTeam measures each call from the provider's own usage report, plus an estimate for anything added since: the larger of characters divided by four and an o200k token count. A summary starts at 829,800 tokens or 85 images. The limit is the smallest one the provider publishes. OpenRouter advertises 1,050,000 tokens for GPT-6.1 Sol, but its endpoints accept 922,000, so OpenTeam uses 922,000; a custom endpoint that publishes nothing gets 128,000. Each call's output is capped at the room above the threshold, 92,200 tokens here, rather than the model's full 128,000.

### The summary and the swap

When the summary is ready, OpenTeam checks that the conversation still starts with the snapshot it summarized. Then it writes the archive and rebuilds the next request: system prompt and tools, user_info, your latest request, the summary, then everything since the snapshot. The summary message ends: "If the task is complete, respond to the user. Otherwise, continue working on the task." The server records each compaction with its reason, its tokens before and after, and its timing.

### Pros

- **Long tasks finish.** A conversation can pass the prompt limit as many times as it needs.
- **No pause while the summary keeps up.** It's written while the bot works.
- **Resent tokens are cheap.** The prompt is ordered and frozen so the provider can cache it.
- **Nothing is deleted.** Summarized messages stay on disk and in the transcript.

### Cons

- **It acts on size, not on cost.** Nothing in the threshold looks at price. Compaction starts at 829,800 tokens, three times the 272,000 above which OpenRouter's listed rates for GPT-6.1 Sol double. In our run, 129 of 175 completed calls went out at the higher rate. The threshold is `botBackgroundThreshold` in `apps/computer/src/compaction/messages.ts`.
- **Replies get only the room above the threshold.** Each call's output is capped at the prompt limit minus the threshold (`withAgentOutputBudget` in `apps/computer/src/runtime/output-budget.ts`). That's 92,200 tokens for GPT-6.1 Sol, but a custom endpoint left at the 128,000-token default gets at most 12,800, which caps how much a single reply or tool call can write.
- **An unfinished summary dies with a restart.** A background summary lives in memory until it's adopted (the `pending` map in `apps/computer/src/compaction/coordinator.ts`). Restarting the bot computer throws that full-size model call away, and the next call starts a new one.
- **Helpers can't look back.** Workers get no transcript pointer, and ReadTranscript refuses them. A helper that compacts keeps only what its summary kept.

## What one long task cost

The bot read all 287 files, wrote a note for each and delivered its review in 218 model calls over 46 minutes.

| What we measured | Result |
|---|---|
| Largest prompt | 910,475 tokens, call 179 |
| Calls above 272,000 tokens | 129 of 175 completed before the summary |
| Before the summary | 179 calls, $32.05 listed |
| The summary call | 910,075 tokens in, 4,916 out, 99 seconds |
| First prompt after the swap | 39,547 tokens |
| After the summary | 39 calls, $2.02 listed, back up to 303,659 tokens |
| All 218 calls | $34.07 listed |

The summary ran to 22,362 characters and stood in for 718 messages. OpenTeam estimated the new prompt at 44,539 tokens; the provider measured 39,547. The last call before the swap listed at $0.20. The first one after it listed at $0.07, most of that for writing the new prompt to the cache, and five calls later they cost under a cent.

The bot never called ReadTranscript. It carried on from a state file and a notes file it had written in `/workspace`, and re-read source files when it needed exact text. Afterwards we asked for two details from a file it had read well before the summary, an MTU and a proxy port. It answered both correctly by opening the file again, "not by relying on the earlier review summary." Here, notes kept outside the conversation did more for recall than the summary did.

That's also why OpenTeam's bots hand long jobs to helpers by default ([how bots delegate and talk to each other](/blog/how-ai-agents-talk-to-each-other)). Each helper works in its own conversation, so the one you talk to stays small. We switched that off to fill a single context on purpose.

## Frequently asked questions

### What is context compaction in AI agents?

It's replacing older conversation with a summary when the conversation nears the model's prompt limit, so the agent can keep working. In OpenTeam it starts at the lower of 90% of the limit and the limit minus 10,000 tokens.

### Why do AI agents get more expensive the longer they work?

Because every call resends everything so far. Caching makes the resent part cheaper, but the prompt still grows, calls get slower, and some providers charge more for long prompts: OpenRouter lists GPT-6.1 Sol at double rates above 272,000 tokens.

### Does compaction make an agent forget things?

It can. The summary keeps the task, decisions and progress, but exact details can drop out. Long-term memory is separate and survives compaction ([how OpenTeam's bots remember](/blog/ai-agent-memory), and the [memory docs](/docs/usage/memory)). OpenTeam keeps the summarized messages and points the bot at ReadTranscript. Our bot didn't need it: it answered questions about details from before the summary by re-reading files and its own notes.

### How much does prompt caching save?

A lot, if the prefix stays stable. In our run, 95.7% of the tokens sent before the summary were cache reads, and the calls listed at $32.05 instead of about $314 uncached.

### Can I change when OpenTeam compacts?

No. The threshold follows the model's prompt limit, and there's no setting for it. A provider can report an earlier threshold, and OpenTeam uses it if it does.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, then follow the [quickstart](/docs/getting-started/quickstart). Pick a provider in **Settings → Model**; compaction works the same way with every model, using that model's own prompt limit.
