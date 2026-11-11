---
title: "Fable 5.2 vs Gemini 4 Carbon vs GPT-6.1 Sol: same six agent jobs"
seoTitle: "Fable 5.2 vs Gemini 4 Carbon vs GPT-6.1 Sol for AI agents"
description: Claude Fable 5.2, Gemini 4 Carbon and GPT-6.1 Sol ran six agent tasks on one self-hosted OpenTeam server. All passed; cost and speed split them.
date: 2026-11-10
category: Comparisons
image: /blog/images/fable-carbon-sol-agent-scorecard.png
imageAlt: A results table for six agent tasks run by Claude Fable 5.2, Gemini 4 Carbon and GPT-6.1 Sol, each with a score, busy time and billed cost, and a cost-per-task total for each model
related: claude-fable-5-2-ai-agents, gpt-6-1-terra-vs-sol-ai-agents, self-hosted-glm-ai-agents
---

**All three models passed all six of our agent tasks in OpenTeam, an open-source app for self-hosted AI agents. GPT-6.1 Sol did it for $0.22 a task, Claude Fable 5.2 for $0.76 and Gemini 4 Carbon for $0.85 at its introductory price. Fable was the quickest at 78 seconds a task; Carbon took almost 11 minutes, checking its own work.**

We build OpenTeam, so weigh our view accordingly. For this post each model ran the same six tasks once, at medium reasoning, in fresh bots on one self-hosted server reached through OpenRouter. We scored every result against answers we worked out ourselves, and the model facts link to each maker's own pages.

![A results table: all three models scored 100 on five tasks and 95 to 98 on the routine; Fable 5.2 averaged $0.76 and 78 seconds a task, Gemini 4 Carbon $0.85 and 10.9 minutes, and GPT-6.1 Sol $0.22 and 2.2 minutes](/blog/images/fable-carbon-sol-agent-scorecard.png "Same six jobs, one run each. The scores barely differ; the costs and times do. Diagram: OpenTeam.")

## Fable 5.2 vs Gemini 4 Carbon vs GPT-6.1 Sol at a glance

Prices are list prices per million tokens from each maker and [OpenRouter's model list](https://openrouter.ai/models), read for this post. The test rows are averages over our six tasks.

| | Claude Fable 5.2 | Gemini 4 Carbon | GPT-6.1 Sol |
|---|---|---|---|
| On OpenRouter since | November 9 | November 10 | September 29 |
| Price in / out | $8 / $40 | $2 / $10 until Nov 30, then $4 / $20 | $2 / $10 |
| Context window | 1M | 1M | 1.05M |
| Effort levels in OpenTeam via OpenRouter | minimal to high | minimal to high | minimal to high |
| Tasks passed (95+ of 100) | 6 of 6 | 6 of 6 | 6 of 6 |
| Billed cost per task | $0.76 | $0.85 | $0.22 |
| Busy time per task | 78 s | 10.9 min | 2.2 min |
| Handed work to a helper | never | on all six tasks | on five of six |

## What's official about Gemini 4 Carbon today

Google announced [Gemini 4 Carbon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-carbon/) on October 28 and gave it first to cybersecurity defenders. On November 10, Google's blog said ["Gemini 4 Carbon is now available"](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/). Developers get it through the API in Google AI Studio and Gemini for business, and Google AI Ultra subscribers in the Gemini app, Antigravity and AI Mode.

The [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog) for November 10 mark `gemini-4-carbon` as generally available. Google Cloud's [model list](https://cloud.google.com/vertex-ai/generative-ai/docs/models) shows it as generally available too, with a separate cyber version behind an allowlist. OpenRouter listed `google/gemini-4-carbon` the same afternoon at $2 and $10.

The price is introductory. Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing) lists $2 in and $10 out through November 30, then $4 and $20 from December 1, and Carbon isn't on the free tier. At December prices, our runs would have cost about $1.71 a task, more than Fable 5.2.

[Claude Fable 5.2](https://www.anthropic.com/claude-fable-and-mythos-5-2) arrived a day earlier at $8 and $40; our [Fable 5.2 deep dive](/blog/claude-fable-5-2-ai-agents) covers its effort levels and how it compares with Opus 5.5. [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) is the incumbent at $2 and $10, and many OpenTeam servers already run it.

## How we tested

Six tasks, each in a fresh bot with an identical prompt, and a rubric written before the first run:

1. **Log in and collect.** Log in to a practice scraping site and save one author's quotes from its JavaScript pages to a CSV.
2. **Research.** The newest PostgreSQL, Node.js Active LTS and Python releases from official sites, with links.
3. **Data job.** Download a dataset, compute three numbers and save a scatter chart.
4. **Routine.** "Every weekday at 8:00 AM, send me a digest of the Hacker News front-page stories that are about AI agents, with links," then a Test run.
5. **Coding.** A duration parser from a spec, checked by 78 hidden tests.
6. **Hard coding.** Cron next-run times with time zones and daylight saving, checked by 48 hidden tests.

The server ran OpenTeam's current release in Docker on a Mac, with web search off and the built-in page reader on, as a new install starts. Costs are what OpenRouter billed for each task's calls, including helpers, matched response by response. OpenRouter served Fable 5.2 from three different providers, sometimes within one task; that didn't change results, but it matters if you care where your requests go. Times are busy time and leave out waiting in the server's queue, which runs four jobs at once. Second runs of two tasks for Sol and for Fable at high effort gave the same scores. The Fable post has the full [method](/blog/claude-fable-5-2-ai-agents).

## Task by task

### Log in and collect quotes

All three found the nine quotes with the right tags. Fable 5.2 did it in one Python script in 19 seconds, logging in with the form's security token and checking for the Logout link. Sol and Carbon each handed it to a helper that drove the bot's browser, taking 3 and 7 minutes. Carbon also pointed out that the site's JavaScript pages still show "Login" after you've signed in.

### Research with sources

All three gave PostgreSQL 18.6, Node.js 26.13.0 and Python 3.15.2 with official links. Sol answered in 14 seconds but put PostgreSQL 19's release candidate in its table and the stable 18.6 in a note below it. Fable explained why it treated v26 as the Active LTS line. Carbon took 8 minutes and 55 tool calls, and noticed that Python's release schedule dates the 3.15.2 announcement a day after the release.

### Data job and chart

All three computed the three numbers exactly and saved a correct chart. Carbon's was the most polished, with sample sizes in the legend and the correlation on the plot. It also read "flipper length against body mass" literally and put flipper length on the vertical axis.

![A scatter chart a bot made with flipper length on the vertical axis and body mass on the horizontal, coloured by species with sample sizes in the legend and a Pearson r of 0.871 annotated](/blog/images/gemini-4-carbon-bot-penguins-chart.png "Gemini 4 Carbon's chart for the data task, as the bot saved it. Image: OpenTeam.")

### Routine from one message

Each bot saved a routine for weekdays at 8:00 in the user's time zone. Each Test run posted a digest whose stories were really on the front page, with working links. Fable's digest arrived about a minute after we pressed Test run and Sol's after under a minute. Carbon's came about 8 minutes after its run started, much of it spent by a helper reading articles.

The judgment calls differed. Sol listed six stories, one of them a magazine piece about AI search that mentions an agent only in passing. Fable and Carbon listed four, and Fable explained what it left out and why.

![The OpenTeam desktop app showing a bot's chat: the routine request, a Created routine notice, and a digest of four Hacker News stories about AI agents, each with a story link, points, comment count and discussion link](/blog/images/openteam-gemini-4-carbon-hn-digest.png "Gemini 4 Carbon's real routine replies and Test run digest, rendered in the desktop app with a sample bot name. Sample data. Image: OpenTeam.")

### Coding and hard coding

All three passed every hidden test on both coding tasks, so the harder task didn't separate them either. The difference was effort. Sol's helper wrote 42 tests in about 4 minutes. Fable wrote 34 tests in 3 minutes without a helper. Carbon's helper worked for about 20 minutes on the cron task, building its own brute-force oracle, running 150 randomised comparisons against it and writing 31 tests.

## Cost per task, and what drives it

![Bar charts of billed cost and busy time per task for seven runs over the same six tasks: GLM-5.3 $0.10 and 45 seconds, GPT-6.1 Terra $0.11, GPT-6.1 Sol $0.22 and 2.2 minutes, Claude Opus 5.5 $0.31 and 45 seconds, Claude Fable 5.2 $0.76 and 78 seconds, Gemini 4 Carbon $0.85 and 10.9 minutes, and Fable 5.2 at high effort $1.62](/blog/images/ai-agent-model-cost-time-per-task.png "The three models compared here in teal, with reference runs from the same server. Diagram: OpenTeam.")

Since every task passed, cost per successful task is the same as cost per task. Sol was cheapest of the three at $0.22, under a third of Fable's $0.76 and about a quarter of Carbon's $0.85.

The bills had different shapes. More than half of Fable's and Sol's spending went on writing the prompt cache at the start of each bot's conversation. Fable's cache writes cost four times Sol's per token. Carbon wrote nothing to the cache but sent about 210,000 fresh input tokens per task through its helpers and their checks.

For reference, the same server ran the same tasks on cheaper models. GPT-6.1 Terra and GLM-5.3 also passed all six, for $0.11 and $0.10 a task; GLM-5.3 missed one of the 78 hidden checks. Opus 5.5, scored on its answers and files, got every task right for $0.31; the Fable post compares the two.

## Speed

Fable 5.2 was the quickest of the three because it did everything in one session: about eight tool calls a task, no helpers. Sol handed five of six tasks to helpers, which adds a hand-off and, on a busy server, a wait in the queue. Carbon used helpers every time and averaged 35 tool calls a task.

Carbon's slowness looks deliberate. Google says Carbon is "built for tasks that test the limits of a model's intelligence." It uses more tokens than its sibling Gemini 4 Argon "to explore thoroughly, reason deeply, and run extended verification loops." On our six everyday tasks that care didn't change a score; it may matter more on harder jobs.

## Where each one was better

**GPT-6.1 Sol** was the cheapest correct answer every time, and the most repeatable: its second runs matched its first, down to how it laid out the research table. It leans on helpers, which costs time on a busy server.

**Claude Fable 5.2** was the quickest and the clearest. It worked alone, finished four of six tasks in under 90 seconds and said what it assumed. Its bill is the heaviest per token, mostly from cache writes.

**Gemini 4 Carbon** checked the most. It built its own test oracle, noticed a one-day discrepancy in Python's release records and annotated its chart. It wasn't billed for cache writes in our runs, and until November 30 its token prices match Sol's. But it spent ten minutes where the others spent one or two.

## Which one should you run?

- **Choose GPT-6.1 Sol if** you want the cheapest of the three for everyday bot work. It was right on every task for $0.22 each.
- **Choose Claude Fable 5.2 if** speed and clear explanations matter more than price, or your bots take on long, hard jobs where Anthropic's benchmarks show it ahead.
- **Choose Gemini 4 Carbon if** you want the most self-checking, and the jobs are hard enough to repay ten minutes and the price after November 30.
- **Choose something cheaper if** your tasks look like ours. GPT-6.1 Terra and GLM-5.3 passed all six for about a dime.

One model serves every bot on an OpenTeam server, so this is a server-wide choice: change it in **Settings → Model** and every bot switches. OpenTeam also has one human account per server, desktop apps for macOS on Apple silicon and Linux, an iPhone app in beta and no Android app.

## Frequently asked questions

### Is Gemini 4 Carbon better than GPT-6.1 Sol for AI agents?

Not on our everyday tasks. Both got all six right, and Sol cost $0.22 a task against Carbon's $0.85, in about a fifth of the time. Carbon checked its work far more thoroughly, which may pay off on harder jobs.

### Is Gemini 4 Carbon generally available?

Yes, since November 10. Google lists `gemini-4-carbon` as generally available in the Gemini API and on Google Cloud, and it's rolling out to Google AI Ultra subscribers. It isn't on the API's free tier.

### How much does Gemini 4 Carbon cost?

$2 per million input tokens and $10 per million output tokens through November 30, 2026, then $4 and $20. Thinking tokens are billed as output. In our test that came to $0.85 a task, about $1.71 at December prices.

### Can I use Gemini 4 Carbon in OpenTeam?

Yes, through OpenRouter as `google/gemini-4-carbon`, or through a custom endpoint for Google's API. OpenTeam has no built-in Google provider. Through OpenRouter it offers minimal, low, medium and high reasoning.

### Which is the best model for AI agents?

For everyday bot work in our test, the cheapest one that passes: GPT-6.1 Terra, GLM-5.3 and GPT-6.1 Sol all got six of six. Pick a larger model when your own tasks fail on a smaller one, and test on your work, not ours.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` and choose a model in **Settings → Model**. The [quickstart](/docs/getting-started/quickstart) covers the rest, and the apps are on the [download page](/download).
