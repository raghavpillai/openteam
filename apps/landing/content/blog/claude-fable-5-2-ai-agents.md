---
title: Claude Fable 5.2 for AI agents, tested in a self-hosted bot team
seoTitle: "Claude Fable 5.2 for AI agents: six real tasks, tested"
description: We ran Claude Fable 5.2 on six agent tasks in OpenTeam, a self-hosted AI agent app, and compared score, cost, speed and effort with Opus 5.5.
date: 2026-11-09
category: Comparisons
image: /blog/images/claude-fable-5-2-agent-scorecard.png
imageAlt: A results table for six agent tasks run by Claude Fable 5.2 at medium and high effort and by Claude Opus 5.5 at medium, with a score, time and billed cost in each cell
related: gpt-6-1-terra-vs-sol-ai-agents, ai-agent-own-computer, self-host-ai-agents
---

**Claude Fable 5.2 passed all six of our agent tasks at medium effort, in OpenTeam, an open-source app for self-hosted AI agents. It averaged $0.76 and 78 seconds a task. High effort scored the same at twice the cost. Opus 5.5 was cheaper at $0.31, but three of its six final answers never reached the chat.**

We build OpenTeam, so weigh our view accordingly. For this post we ran each task in a fresh bot on one self-hosted server, through OpenRouter. We scored every result against answers we worked out ourselves. Claims about Fable 5.2 link to Anthropic's announcement and docs.

![A results table for six tasks: Fable 5.2 at medium and high scored 100 on five tasks and 98 on the routine; Opus 5.5 scored 0 on the research task because its answer never reached the chat, 100 on both coding tasks with the reports flagged as not sent, and 97 to 100 elsewhere, with time and billed cost in each cell](/blog/images/claude-fable-5-2-agent-scorecard.png "Each cell is one run. Fable 5.2 passed every task; the differences are cost, time and whether the answer arrived. Diagram: OpenTeam.")

## Claude Fable 5.2 at a glance

Anthropic released [Claude Fable 5.2 and Claude Mythos 5.2](https://www.anthropic.com/claude-fable-and-mythos-5-2) on November 9, 2026. They are the same underlying model; Mythos keeps its cyber and biology abilities for vetted programs, and Fable is the one everyone can use. Prices are from Anthropic's announcement and [OpenRouter's model list](https://openrouter.ai/anthropic/claude-fable-5.2).

| | Claude Fable 5.2 | Claude Opus 5.5 |
|---|---|---|
| API price per million tokens | $8 in, $40 out | $4 in, $20 out |
| Cached input reads | $0.20 | $0.20 |
| Context window | 1M tokens | 1M tokens |
| Effort levels in Anthropic's API | low to max, default high | low to max, default medium |
| Effort levels in OpenTeam via OpenRouter | minimal, low, medium, high | minimal, low, medium, high |
| Our score, six tasks | 99.6 at medium and at high | 99.5 on content, 82.8 as delivered |
| Billed cost per task in our test | $0.76 medium, $1.62 high | $0.31 medium |

## What Anthropic says changed

The announcement makes four claims that matter for agents. Fable 5.2 generates output up to 30% faster than Fable 5.1, at a lower price. An optional fast mode is up to 2.5 times faster, for $16 in and $80 out per million tokens. At medium effort it "can accomplish challenging tasks with fewer tokens than Fable 5.1."

It also blocks less: in early testing Anthropic "observed about 55% fewer blocks with Fable 5.2 compared with Fable 5.1." The headline agent demo has Fable coordinating more than 1,000 subagents for eight days to build an operating system that boots on a laptop.

The advice for picking a model is unusually direct: "For most coding and knowledge tasks, we recommend that users start with Claude Opus 5.5," then move up to Fable for the hardest work. On Anthropic's FrontierCode 2.0 coding benchmark, Fable 5.2 at high effort scored about the same as Opus 5.5's best (45.3% against 45.5%) for roughly half the cost per task.

![Anthropic's FrontierCode 2.0 chart of score against cost per task on a log scale: Fable 5.2 rises from low to medium, high and Xhigh at 49.1%, then drops slightly at Max, which costs several times more; Opus 5.5, Fable 5.1, GPT-6 Astra and Gemini 4 Carbon are plotted for comparison](/blog/images/anthropic-fable-5-2-frontiercode-cost-chart.png "Anthropic's own chart: Max costs far more than Xhigh and scores lower. Screenshot: Claude Fable 5.2 announcement, Anthropic.")

[Vals AI](https://x.com/ValsAI/status/2119869713782378658) put Fable 5.2 first on its Vals Index the same day and added that "'high' was the most performant effort - scoring higher than 'low', 'max', and 'xhigh'." Anthropic's [effort guide](https://platform.claude.com/docs/en/build-with-claude/effort) says the same in its own words: start at high, and reserve max for measuring the model's ceiling.

## How we tested

We wrote six tasks that look like everyday bot work and fixed a scoring rubric before the first run. The answers come from our own checks: the real quote set, each project's release page, numbers we computed, the live Hacker News front page and hidden tests.

| Task | What the bot had to do | How we scored it |
|---|---|---|
| Log in and collect | Log in to a practice site, collect one author's quotes from its JavaScript pages into a CSV | Exact quote set, tags, file, evidence of the login |
| Research | Find the newest PostgreSQL, Node.js Active LTS and Python releases on official sites, with links | Version, date and link per row |
| Data job | Download a dataset, compute three numbers and save a chart | Numbers to the decimal, chart checked by eye |
| Routine | "Every weekday at 8:00 AM, send me a digest of the Hacker News front-page stories that are about AI agents, with links," then a Test run | Schedule, time zone, real front-page stories, relevance, working links |
| Coding | Implement a duration parser from a spec and test it | 78 hidden checks |
| Hard coding | Implement cron next-run times with time zones and daylight-saving rules | 48 hidden checks |

Each run got a fresh bot and the same prompt, and nobody nudged a bot mid-task. We repeated two tasks at high effort, and both scored the same again. Costs are what OpenRouter billed for every model call, including any helpers a bot started; we matched each response ID against OpenRouter's billing records. Times are the bots' busy time, leaving out the seconds a run waited in the server's queue.

The server ran OpenTeam's current release in Docker on a Mac, with search off and the built-in page reader on, as a new install starts. Each bot works on [its own Linux computer](/blog/ai-agent-own-computer) with a browser and a terminal, and the [self-hosting guide](/blog/self-host-ai-agents) covers the same setup on a home server.

## Fable 5.2 vs Opus 5.5 on the same tasks

On correctness, there was nothing between them. Both found the nine quotes with their tags, got the three release facts and the three data numbers exactly, and passed every hidden test on both coding tasks. Neither picked a story for the digest that wasn't on the front page, and every link worked.

The differences were in how they worked. Fable 5.2 never handed work to a helper; it did each task in its own session with about eight tool calls. On the login task it wrote one Python script that logged in, checked for the Logout link and read the quotes. Then it told us how: "I read the quotes from the data embedded in each JavaScript page rather than rendering the pages in a browser." That took 19 seconds and cost 10 cents.

On research it explained its one judgment call. "The Node.js site labels v22, v24 and v26 all just 'LTS'," it wrote, so it checked the project's release schedule to confirm v26 was the Active line. Its digests each listed four stories, said which ones were a stretch and why it left others out.

![The OpenTeam desktop app showing a bot's reply to the research task: a table with PostgreSQL 18.6 from August 13, 2026, Node.js 26.13.0 Lithium from October 28 and Python 3.15.2 from October 25, each with an official link, and a note explaining the two judgment calls](/blog/images/openteam-fable-5-2-research-reply.png "Fable 5.2's real reply to the research task at high effort, rendered in the desktop app with a sample bot name. Sample data. Image: OpenTeam.")

### Where Opus 5.5 fell short

Opus 5.5 was faster, at 45 seconds a task, and less than half the price. But on three of six tasks its final answer never reached the chat. It sent a short message such as "Checking the three official sites now," finished the work, and then wrote its report as plain text instead of sending it.

In OpenTeam, a bot talks to you only through a send tool, and plain text stays private by design. The tool's own instructions say an acknowledgement isn't delivery. OpenTeam doesn't catch a turn that ends this way, so you'd see the acknowledgement and nothing else. That's a gap in OpenTeam as much as a model habit. We reran two of those tasks: the research answer arrived the second time, but the coding report stayed silent again, so four of eight Opus runs ended this way. None of Fable's 16 runs did.

On the coding tasks the files were correct anyway, so we scored them on the files. On the research task the answer was the whole job, so as you'd have seen it, Opus scored zero.

## Which effort level was worth it

OpenTeam starts every newly chosen model at medium. Through OpenRouter it offers Fable 5.2 at minimal, low, medium and high. When we asked the server for xhigh or max, it refused: "Anthropic: Claude Fable 5.2 does not support reasoning level max." OpenTeam offers the top two levels only when its bundled model registry maps them, and that registry doesn't list Fable 5.2 yet. So we couldn't test Vals' finding about max.

We could test the rest. Fable 5.2 ran all six tasks at medium and at high, and the routine and hard-coding tasks at low too. Scores didn't move at all: 99.6 on average at both medium and high, and identical on the two tasks run at all three levels.

![Bar charts of cost and time per task for Fable 5.2 at low, medium and high and Opus 5.5 at medium: on the routine and hard-coding tasks low cost $1.07, medium $1.16 and high $2.53 a task; over all six tasks medium cost $0.76 and 78 seconds, high $1.62 and 3.2 minutes, and Opus $0.31 and 45 seconds](/blog/images/claude-fable-5-2-effort-cost-time.png "Higher effort didn't change a single score, so the chart shows what it did change. Diagram: OpenTeam.")

What changed was the bill and the wait. High cost $1.62 a task against $0.76, and took 3.2 minutes against 78 seconds. The two coding tasks were where high spent the most time: 7 and 8 minutes, against 1.6 and 3 minutes at medium, for the same result.

Low saved less than you'd expect. On the hard-coding task it cost $0.69 against $0.91 at medium, but on the routine it cost the same as medium. The reason is the prompt cache: 58% of Fable's bill at medium was cache writes, at $10 per million tokens, and effort doesn't change how much a bot writes there.

So for everyday agent work, medium was the right level. Anthropic and Vals both point to high for hard problems, and our results don't argue with that for long, difficult jobs. These six tasks weren't that hard, and high didn't help on them.

## Cost per task, and what drives it

Across the six tasks at medium, Fable 5.2 cost $4.53, or $0.76 a task. Output was $1.68 of that, cache writes $2.61, cache reads 23 cents and fresh input about a cent. Opus 5.5 did the same work for $1.85, and its bill had the same shape at half the per-token price.

Two things push the cost up in a bot team. Every new conversation writes the bot's instructions and tools to the prompt cache, and a research task writes the pages it reads there too. Our research task cost $1.17 at medium and $2.61 at high, mostly cache writes, while a reply-sized task like the login cost 10 cents.

A second run of the research task at high cost $1.26, so these costs swing with how much a bot reads. If you run many short tasks on Fable 5.2, that first write is most of the price, and effort settings won't change it.

## Refusals, speed and reliability

Fable 5.2 refused nothing across its 16 runs. Our tasks were ordinary, so that says little about the cyber and biology cases Anthropic's safeguards target; Vals' [model page](https://www.vals.ai/models/anthropic_claude-fable-5-2) reports a 0.00% refusal rate on its index.

At medium it averaged 78 seconds of busy time a task. That's slower than Opus 5.5 at 45 seconds but faster than GPT-6.1 Sol at 2.2 minutes, which handed most tasks to helpers. No run needed a nudge.

One thing went wrong that wasn't Fable's fault. On our Mac, the bot computer's connections to sites with IPv6 addresses, such as GitHub and Hacker News, failed with "Broken pipe". The network had no IPv6, but the bot computer accepted those connections and then dropped them, so tools didn't fall back to IPv4. That's an OpenTeam bug, found in this test.

Fable worked around it each time. "raw.githubusercontent.com kept dropping the connection from my computer's terminal," it reported, "so I pulled the same file at the same commit through GitHub's API instead."

![A scatter chart a bot made of penguin flipper length against body mass, coloured by species with a legend and the Pearson r of 0.871 in the title](/blog/images/fable-5-2-bot-penguins-chart.png "The chart Fable 5.2 made for the data task at high effort, as it saved it. Image: OpenTeam.")

## How to use Claude Fable 5.2 in OpenTeam

One model serves every bot on an OpenTeam server, so switching to Fable 5.2 switches them all. Open **Settings → Model** in the desktop or iPhone app, choose **OpenRouter** and add your API key, pick Claude Fable 5.2, set the reasoning effort and choose **Apply**. The app sends a short test message before saving ([model providers](/docs/configuration/models)).

![OpenTeam's Model settings with OpenRouter as the provider, Claude Fable 5.2 as the model and the Reasoning effort menu open, offering Minimal, Low, Medium and High](/blog/images/openteam-model-settings-fable-5-2-reasoning.png "Through OpenRouter, the effort menu stops at High for Fable 5.2. Sample data. Image: OpenTeam.")

On the server you can do the same with `openteam model use openrouter anthropic/claude-fable-5.2 --thinking medium`. An Anthropic API key works too, as a separate provider; we didn't test that route for this post, so we can't say which effort levels it offers.

OpenTeam can also sign in with a Claude subscription. According to Anthropic's [help center](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan), Fable models are part of Max and Ultra plans up to 50% of the weekly usage limit, and run on paid usage credits on Pro. For the [launch week](https://support.claude.com/en/articles/17506494), Pro plans also get Fable up to 50% of weekly limits through November 16. We didn't test the subscription route.

Fable 5.2 is also one of Anthropic's [Covered Models](https://support.claude.com/en/articles/15425695-covered-models). By default its prompts and completions are kept for at least 30 days on every platform that offers it, and zero data retention isn't available. Your conversations, files and memory stay on your OpenTeam server, but the model provider still sees what each task sends ([privacy](/docs/configuration/privacy)).

OpenTeam's own limits apply whichever model you pick. There's one human account per server, desktop apps for macOS on Apple silicon and Linux, an iPhone app in beta and no Android app. Bots act without asking first, except that email, Slack and Messages sends go through cards you approve.

## When Opus 5.5 is the better pick

Anthropic's advice held up in our test. Opus 5.5 got the same answers on every task, at 41% of Fable's cost per task and in a little over half the time. If your bots mostly fetch, summarise, file and fix things, Opus is the better default. Cheaper models are too: GPT-6.1 Sol did the same six tasks for $0.22 each; our [Terra vs Sol comparison](/blog/gpt-6-1-terra-vs-sol-ai-agents) looks at OpenAI's two options.

Choose Fable 5.2 if your bots run long, hard jobs where Anthropic's own benchmarks show a gap. It's also the safer bet if a reliably delivered final answer matters more than price. Choose Opus 5.5 if the work looks like our six tasks and you watch for answers that don't arrive.

## Frequently asked questions

### Is Claude Fable 5.2 better than Opus 5.5 for AI agents?

Not on everyday tasks, in our test. Both got all six tasks right on content, and Opus cost $0.31 a task against Fable's $0.76. Fable was the more reliable messenger: every final answer arrived, while four of eight Opus 5.5 runs left theirs as text OpenTeam doesn't show.

### Which effort level should I use for Fable 5.2?

Medium for routine agent work. High scored the same on our six tasks and cost twice as much, and low saved little because cache writes dominate the bill. Anthropic and Vals AI recommend high for hard problems.

### Can I run Fable 5.2 at max effort in OpenTeam?

Not through OpenRouter today. OpenTeam offers minimal to high for Fable 5.2 there and rejects xhigh and max. It offers those two levels only for models in its bundled registry.

### How much does Claude Fable 5.2 cost per task?

The list price is $8 per million input tokens and $40 per million output tokens. In our bot team that came to $0.76 a task at medium and $1.62 at high. More than half of it went on writing the prompt cache.

### Can I use Claude Fable 5.2 with a Claude subscription?

Yes, within limits. On Max and Ultra, Fable models are included up to 50% of your weekly usage limit. On Pro they run on paid usage credits, with extra launch-week usage until November 16. OpenTeam supports a Claude subscription sign-in, but we didn't test it with Fable 5.2.

### Does Claude Fable 5.2 refuse more than other models?

Not in our test: none of its 16 runs refused anything. Anthropic reports about 55% fewer blocks than Fable 5.1, and Vals AI lists a 0.00% refusal rate on its index.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh`, then pick a model in **Settings → Model**. The [quickstart](/docs/getting-started/quickstart) walks through the rest, and the apps are on the [download page](/download).
