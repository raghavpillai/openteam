---
title: "How OpenTeam's AI agents remember: dated Markdown in four scopes"
seoTitle: "AI agent memory: how OpenTeam bots remember with Markdown"
description: "OpenTeam's self-hosted AI agents keep memory as dated Markdown facts in four scopes. How learning, recall and budgets work, built up one step at a time."
date: 2026-10-16
updated: 2026-11-10
category: Engineering
image: /blog/images/memory-design-overview.png
imageAlt: "Ladder of memory designs from v0, the bare context window, to where OpenTeam ended up, above a table comparing the two"
related: how-ai-agents-talk-to-each-other, introducing-openteam, best-self-hosted-ai-agents
---

**OpenTeam's bots remember by writing short, dated facts into Markdown files: a profile of lasting facts plus monthly logs, kept separately for each bot, for you and for shared projects. After each real exchange, a background model call decides what to keep. Every prompt gets a budgeted slice, and a word-search tool finds the rest. There are no embeddings.**

> **Note:** This post describes memory as it worked in OpenTeam v0.0.3. Since v0.0.6, memory lives in the server's database instead of Markdown files, in two scopes: each bot's own memory and shared memory about you. Bots save and drop facts with a dedicated memory tool, each fact records which bot saved it and how, and projects, dreaming and episode summaries were removed. To check or change what a bot remembers, ask it; [memory](/docs/usage/memory) covers how it works today.

We build OpenTeam, an open-source (GPL-3.0), self-hosted AI agent team, so read this as a practitioner's account, not a neutral survey. It describes OpenTeam as of v0.0.3, and the numbers come from the source code. We build the design up in steps, from the simplest thing that could work to what OpenTeam runs today; the version numbers exist only for this post.

## Why AI agents forget between conversations

A language model keeps nothing between calls, so whatever an agent knows about you has to be in that turn's prompt. Long chats make it worse: near the end of the context window they get summarized, and details fall out.

OpenTeam runs a team of bots on your own server, each with its own Linux computer. They talk with you and with each other in group chats ([how OpenTeam works](/blog/introducing-openteam)). So memory has three jobs:

- **Remember you.** Your name, time zone and preferences should follow you to every bot.
- **Remember itself.** A bot's role, and what it learned doing its job, belong to that bot.
- **Remember shared work.** A project's decisions should reach every bot working on it.

Two constraints follow. Several bots write at once, so writes can't collide. And group chats include other bots, so not every memory belongs there.

## v0: the context window

The simplest memory is none: the bot knows what's in the current chat.

**How it works.** The model sees the conversation so far and nothing else. When a chat reaches 90% of the model's context window, OpenTeam summarizes the older part in the background. A new chat starts empty.

![Diagram of v0: a turn between you and the bot, and a context window holding the chat so far. No other memory exists.](/blog/images/memory-design-v0.png "v0: the chat is the memory. Diagram: OpenTeam.")

**Pros.**

- It's free: no storage, no extra model calls, nothing to maintain.
- Nothing goes stale, and nothing leaks from one chat into another.
- Until compaction, the model sees your exact words, not someone's summary of them.

**Cons.**

- Every chat starts from zero, so you repeat your name, time zone and preferences.
- Compaction keeps a summary, and details fall out. Give a bot your flight number early in a long chat, and after compaction it may only know you have a flight.

## v1: a notes file in the prompt

Give each bot a file it can write to, and put the whole file in every prompt.

**How it works.** A save tool appends one line to the bot's `notes.md`. Every prompt includes the entire file. Nothing is dated, and nothing leaves the file unless the bot rewrites it. Instruction files such as `CLAUDE.md` and `AGENTS.md` work this way, except that people write them by hand.

![Diagram of v1: a save tool appends lines to one notes file, and the whole file goes into every prompt.](/blog/images/memory-design-v1.png "v1: a file outlives the chat, but it only grows. Diagram: OpenTeam.")

**Pros.**

- It survives a new chat and a compaction.
- It's plain text you can read, grep and fix.
- Everything the bot saved is always in view, so there's nothing to search.

**Cons.**

- It only grows, and every line costs prompt space on every turn.
- Nothing says which line is newer. "Lives in Austin" sits above "Lives in Lisbon," and the bot has to guess where you live.

## v2: dated facts and a budget

Date every fact, separate lasting facts from history, and give the prompt a budget.

**How it works.** Memory becomes a folder with two kinds of file: `profile.md` for lasting facts and monthly logs under `log/`. Every fact is one line:

```markdown
# Memory log

<!-- Safe to read, grep, and edit. One fact per line, as "- (YYYY-MM-DD) <fact>". -->

- (YYYY-MM-DD) Wants weekly reports to lead with decisions, then blockers
- (YYYY-MM-DD) Booked a rooftop venue in Lisbon for the team offsite
- (YYYY-MM-DD) [note] Likes rooftop venues
```

A line counts only if it matches that pattern with a real calendar date; anything else in the file is left alone. Facts stop at 500 characters. Each fact's identity is a hash of its lowercased text, so duplicates collapse and a forget can find its line. The bot writes or forgets a fact with `update_state`, choosing a tier: `profile`, `log`, or `note` for minor details, which become log lines tagged `[note]`.

The prompt gets the profile, up to 100 facts, plus the 30 highest-ranked recent facts within 4,000 characters. A block stops at the first fact that would overflow it, and a line tells the bot how many facts it left out. A fact's rank is its date in 30-day units plus the base-2 log of a weight. Notes weigh 0.5, so a note ranks like a fact 30 days older; everything else weighs 1.

![Diagram of v2: update_state writes dated facts into profile.md and monthly logs, and the prompt gets the profile plus the top 30 recent facts within 4,000 characters.](/blog/images/memory-design-v2.png "v2: dates and a budget keep the prompt bounded. Diagram: OpenTeam.")

**Pros.**

- Dates settle which fact is newer, and lasting facts stay in view.
- History has a ceiling in the prompt, so memory can grow without crowding the chat.
- It's still plain files.

**Cons.**

- Notes and old logs fade from the prompt by design, whether or not they still matter.
- Anything outside the slice is invisible. Months later, "Which venue did we book in Lisbon?" has no answer: the booking ranked out of the top 30, and the bot can't look for it.

## v3: search and an index

Let the bot search everything on disk, and keep an index so searching stays fast.

**How it works.** `RecallMemory` splits a query into words of four or more letters, drops common stopwords and ranks facts by shared words, then by date. If nothing overlaps, it falls back to a literal substring match. It returns 20 facts by default and 50 at most, within 4,000 characters. Bots can also read and grep the files with the shell on their own computer.

Postgres holds an index of every fact. The server rebuilds it from the files before every turn and every search, so a hand edit always wins. The bot's instructions say: "Files are the source of truth; deleting a fact line ... deletes that state instead of regenerating it from PostgreSQL."

That sentence records real history. We first kept facts as rows in a Postgres table, changed only through `update_state`. You needed a database client to see what a bot knew, and nothing outside the prompt's slice could be searched. Moving the truth into files fixed the first problem; Postgres stayed as the index.

![Diagram of v3: a Postgres index rebuilt from the files every turn, and a RecallMemory word-search tool that reaches facts outside the prompt.](/blog/images/memory-design-v3.png "v3: everything on disk is reachable. Diagram: OpenTeam.")

**Pros.**

- Every fact is reachable, not only the slice in the prompt.
- A hand edit wins on the next turn, and deleting a line really deletes the fact.
- Search is cheap: no embedding model and no vector index.

**Cons.**

- Memory still grows only when the bot decides to save. You mention in passing that you're moving to Lisbon; the bot answers your question and saves nothing.

## v4: automatic learning

After each real exchange, a separate model call decides what's worth keeping.

**How it works.** Only turns from your direct and group chats count, not routines, connector events or direct bot-to-bot messages. A filter skips small talk: a message of 40 characters or fewer, with no question mark, that matches one of 32 phrases such as "thanks", "ok" or "lol". Anything else goes to the extraction call, which has no tools.

That call sees the exchange and up to 140 facts it already knows: 100 profile facts, the 30 highest-ranked recent ones and up to 10 others that share words with the exchange. It answers in plain lines, `profile:`, `log:`, `note:` or `remove:`, or with `NONE`. A `remove:` line counts only if it quotes one of those facts exactly. So the learner can retire "Lives in Austin" after you move, but it can't invent deletions. Our first learner returned new facts as JSON and could only add; `remove:` came later.

Every sixth eligible turn, an episode call writes one or two sentences about what you worked on, saved as an `[episode]` line. Episodes weigh 1.5, so one ranks like a fact about 18 days newer. Both calls use the same model as your bots by default.

![Diagram of v4: a learner reads each finished turn, sees 140 known facts and adds facts or retires one with a remove: line.](/blog/images/memory-design-step-v4.png "v4: memory grows without being asked. Diagram: OpenTeam.")

**Pros.**

- Memory grows without anyone asking.
- Corrections retire stale facts instead of stacking them.
- The filter is free: "thanks" and "ok" never reach a model.

**Cons.**

- Each bot keeps one store for everything. Tell one bot your time zone and the next one asks again.

## v5: scopes and shards

Split memory by whom it's about, and give every file exactly one writer.

**How it works.** There are three scopes. Bot memory, under `agents/<bot>/memory/`, is the default for every save. User memory holds what every bot should know about you. Project memory holds a project's decisions for the bots that joined it. The shared scopes are sharded, one folder per writing bot: `user-memory/by-agent/<bot>/` and `projects/<slug>/memory/by-agent/<bot>/`. Each bot writes only its own shard, so writes never collide. Readers merge the shards, and the newest fact wins a conflict. When scopes disagree, a bot prefers its own memory, then project memory, then user memory. `RecallMemory` now searches user memory too.

Group chats get a firm line around you. They can't read or write user memory, and `update_state` refuses a user-scope save there. A bot's own memory goes with it into groups, so if a bot belongs to any group, its prompt calls its memory team-wide and asks it to mention every team-wide save or forget.

Learning also moved to after delivery. Group replies wait in an outbox until the turn settles. Extraction used to run before they were published, so the learner never saw what the group saw. Now it runs after delivery, and a test checks that it sees every visible reply.

A fourth, legacy scope holds older per-room memory, readable only to the same room and bots, and a forget cleans up copies there too.

![Diagram of v5: bot, user and project scopes with one writer per file, no user memory in group chats, and learning after replies are delivered.](/blog/images/memory-design-step-v5.png "v5: memory is split by whom it's about. Diagram: OpenTeam.")

**Pros.**

- A fact saved as user memory reaches every bot in your direct chats.
- Shared files never collide, because every file has one writer.
- Group chats never see user memory.

## Where we ended up

The design today has three ways in, one source of truth and three ways out.

![Flow diagram: update_state, the learner and the episode summary write Markdown files indexed in Postgres; the prompt, RecallMemory and grep read them.](/blog/images/memory-design-paths.png "The write path and the read path. Every arrow runs through the files. Diagram: OpenTeam.")

### Files and index

Every scope is a folder of `profile.md` and monthly logs, one dated fact per line, 500 characters at most. Postgres is an index rebuilt from the files before every turn and every search, so a hand edit always wins. Shared scopes keep one shard per writing bot; readers merge them, and the newest fact wins.

### Write path

After the reply is delivered, an eligible turn goes through the small-talk filter, then the extraction call: no tools, up to 140 known facts, and `profile:`, `log:`, `note:` or `remove:` lines back. Every sixth eligible turn adds a one- or two-sentence episode. Automatic learning writes only the bot's own memory. User and project memory grow only through explicit saves: `update_state` writes or forgets a fact whenever you ask or the bot decides, in any scope the chat allows. Both paths append to the files under a per-bot lock, then rebuild the index.

### Read path and budgets

Every prompt gets a memory section: user memory (in direct chats), up to three projects, then the bot's own facts. Each block has a budget, stops at the first fact that would overflow it, and tells the bot how many facts it left on disk. Recent facts are ranked by date and weight.

| Memory block | Facts | Characters |
|---|---|---|
| Bot memory, profile | Up to 100 | 500 per fact |
| Bot memory, recent | Top 30 by rank | 4,000 |
| User memory, profile | Up to 50 | 4,000 |
| User memory, recent | Up to 15 | 2,000 |
| Project memory, profile (each of up to 3) | Up to 25 | 2,500 |
| Project memory, recent (each of up to 3) | Up to 10 | 1,500 |
| `RecallMemory` result | 20 by default, 50 at most | 4,000 |

`RecallMemory` covers the bot's own memory and user memory. For project memory, bots grep the project folders on their computer. The `executor` and `knowledgeWork` helper workers can call `RecallMemory` too, scoped to the conversation that started them.

### Scopes and controls

![Table of OpenTeam's four memory scopes, bot, user, project and legacy room memory, with their folders, readers, writers and group-chat access.](/blog/images/memory-design-four-scopes.png "Group chats get the bot's own and project memory, never your user memory. Diagram: OpenTeam.")

In the desktop app, open a bot's details and choose **Memories** to search, delete one fact or clear them all. The panel lists up to 1,000 facts and labels new ones; clearing keeps shared user and project memory. You can also ask a bot to forget something, or edit the files.

### Synthesis and compaction

An optional synthesis pass, "dreaming," merges, rewrites and removes facts across a store. It stays off unless you set `OPENTEAM_MEMORY_DREAMING`. Each change must cite evidence from recent exchanges and win a second model call's approval. Its prompts tell both models never to change facts you saved on purpose.

Compaction still works as in v0, and its summary is separate from memory. The memory section belongs to a stable prompt prefix that stays fixed between compactions. Mid-conversation changes arrive as a short note of added (+) and removed (−) lines, and the next compaction rebuilds the section from the files.

### Pros

- **You can see all of it.** Every fact is a dated line you can read, grep, edit or back up with the agent-data volume.
- **It maintains itself.** It grows after real exchanges, retires facts that a new exchange contradicts, and keeps every block but the profile under a ceiling.
- **It's cheap.** There's no embedding model or vector store, only one extra model call per eligible turn.
- **Sharing has rules.** Facts saved as user memory reach every bot, never a group chat, and shared files never collide.

## How this compares with other AI agent memory designs

None of these ideas are new, and each design below is good at something.

| Approach | Good at | Costs |
|---|---|---|
| Embedding retrieval over a memory stream ([Generative Agents](https://arxiv.org/abs/2304.03442)) | Paraphrases; ranks by recency, importance and similarity | An embedding model and an index |
| Tiered, self-edited memory ([MemGPT](https://arxiv.org/abs/2310.08560), now Letta) | The agent manages its own context; unbounded archive | Memory tool calls during the task |
| Extract and update ([Mem0](https://arxiv.org/abs/2504.19413)) | Compact facts; 91% lower p95 latency and over 90% fewer tokens than full context, per the paper | A model call per message plus a vector store |
| Temporal knowledge graph ([Zep](https://arxiv.org/abs/2501.13956), [Graphiti](https://github.com/getzep/graphiti)) | Facts that change; validity windows; relationships | A graph database and entity extraction |
| Hosted assistant memory ([ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/), [Claude](https://www.anthropic.com/news/memory)) | No setup; view and delete controls; temporary or incognito chats | Lives with the vendor |
| Instruction files ([CLAUDE.md](https://code.claude.com/docs/en/memory), [AGENTS.md](https://agents.md/)) | Stable conventions, always in context | Hand upkeep |
| OpenTeam's dated Markdown | Readable, editable and greppable; scoped per bot, user and project | A model call per eligible turn |

The closest relatives are hosted assistants and instruction files. [ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/) keeps "saved memories" and can also draw on "chat history." [Claude](https://www.anthropic.com/news/memory) has project-scoped memory with view-and-edit controls. [Claude Code](https://code.claude.com/docs/en/memory) loads `CLAUDE.md` files from four scopes and keeps an automatic `MEMORY.md`, of which only the first 200 lines or 25 KB load each session. OpenTeam's split, a small profile always in context and dated logs searched on demand, has the same shape.

Outside evidence suggests files hold up well. Letta reported 74.0% on the LoCoMo benchmark with a GPT-4o mini agent using only file tools such as grep, "significantly above Mem0's reported 68.5% score for their top-performing graph variant" ([Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory)). Mem0's own paper put a full-context baseline at 72.9% on the same benchmark. Vercel found that a compressed docs index in `AGENTS.md` reached a 100% pass rate on its Next.js evals, against 53% for no docs or a default skill ([Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)). That favors keeping often-needed facts in the prompt instead of hoping the agent goes looking.

## Frequently asked questions

### How do AI agents remember things?

By putting text back into the prompt. A model keeps no state between calls, so agents save facts in files, a database, a vector index or a graph, and load the relevant ones each turn. OpenTeam loads a budgeted slice of dated Markdown facts every turn and searches the rest by word overlap.

### Can I tell a bot to remember something for all my bots?

Yes. Ask it to remember the fact for all your bots, and it saves it as user memory, which every bot sees in your direct chats. Group chats never see user memory.

### Can I edit or delete what a bot remembers?

Yes. Ask the bot what it remembers and tell it what to forget or correct, or use a bot's **Memories** panel in the desktop app. You can also edit the Markdown files on the server; the next turn picks up the change. See [memory](/docs/usage/memory).

### Do bots share memory?

Yes, by scope. Each bot has its own memory. User memory is shared by all your bots in direct chats, and project memory by the bots that joined the project. Group chats never see user memory.

### What happens to memory when a conversation gets too long?

Memory is unaffected. OpenTeam summarizes the older part of the conversation in the background, then rebuilds the memory section from the files. Your full chat history stays in the app.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, then connect the desktop app. Desktop apps run on macOS (Apple silicon) and Linux (x64), and the iPhone app is on TestFlight. For how OpenTeam compares with other options, read [the best self-hosted AI agents](/blog/best-self-hosted-ai-agents).
