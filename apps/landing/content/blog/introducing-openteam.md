---
title: Introducing OpenTeam: AI agents that each get their own computer
seoTitle: Introducing OpenTeam: an open-source Grok Bot alternative
description: OpenTeam v0.0.0 is the first release of our open-source, self-hosted Grok Bot alternative. What each bot gets, and how it works.
date: 2026-10-06
updated: 2026-11-10
category: Announcements
image: /blog/images/openteam-desktop-mobile.png
imageAlt: The OpenTeam desktop app and iPhone app showing the same chat with a Research bot that compared three vendors and set up a weekday pricing check
related: claude-cowork-alternative, openclaw-alternative, best-self-hosted-ai-agents
---

**OpenTeam is an open-source, self-hosted Grok Bot alternative: software that runs a team of AI bots on a machine you own, each working on its own Linux desktop. It's free under GPL-3.0 and runs with Docker on macOS, Linux or Windows, with the model provider you choose or a local model.**

Run this on the machine that will host your bots (macOS or Linux):

```sh
curl -fsSL https://openteam.so/install | sh
```

On Windows, run `irm https://openteam.so/install.ps1 | iex` in PowerShell. You need Docker with Compose 2.20 or newer, and we recommend 8 GB of RAM and 8 GB of free disk. Guided setup follows, and the [quickstart](/docs/getting-started/quickstart) walks you through it.

## Why we built OpenTeam

OpenTeam's goal fits in one line: self-hosted AI agents that keep working on your own hardware. Four design choices follow from it.

**Work that outlives the app.** Bots run on the server, not in the app you chat from, so they keep going when you close it and resume after a restart.

**A computer, not only a list of tools.** Plenty of work happens on websites without an API, so each bot gets a persistent desktop and browser that you can watch or take over.

**A team, not one assistant.** Separate bots hold separate roles and conversations, share files, and message each other. Group chats have hard limits, so a room of bots settles instead of looping.

**A machine you own.** Conversations, files, memory and website sign-ins stay on your server. You pick the model provider, or run a local model so requests stay on your hardware too.

None of these ideas is new. xAI's [Grok Bot](https://x.ai/news/introducing-grok-bot), launched on August 11, brought the first three together as a hosted service. OpenTeam follows the same design, and its agent tools, prompt and built-in skills are built for compatibility with Grok Bot's. The difference is the fourth idea: it's open source, and it runs on hardware you control with the model provider you choose.

## What each bot gets

### A desktop and browser of its own

Every bot has a persistent Linux desktop: XFCE at 1280×800 by default, with Chromium, a file manager and a terminal. One container on your server can run up to 100 of them. Open a bot's screen in the desktop or iPhone app to watch it live, or take control.

![A bot's XFCE desktop with Chromium open to a sample vendor comparison report](/screenshots/linux-vendor-review.png "A bot's own desktop, with a sample report open in Chromium. Captured September 12, 2026. Image: OpenTeam.")

When a site needs a CAPTCHA, a 2FA code or a payment, the bot posts a card asking you to take over, then continues once you hand control back.

### Shared files and sign-ins

All bots work in one shared `/workspace` folder, so one bot can pick up a file another one wrote. Their browsers share website sign-ins too: sign in once on any bot's screen and every bot is signed in.

![A bot's desktop with Chromium showing a sample sign-in page with email and password fields](/screenshots/linux-sign-in.png "Sign in once on any bot's screen and every bot is signed in. Sample page, captured September 12, 2026. Image: OpenTeam.")

For passwords, a bot can show you a form in the chat instead of asking you to paste anything. OpenTeam fills your answer into the bot's browser, and the model never sees the value.

### Memory you can read

Bots keep their conversations across restarts. They also keep memory: short facts about their own role and about you, stored on your server. Ask a bot what it remembers, and tell it what to correct or forget.

### Routines

A routine is a saved instruction that runs on a schedule, like the weekday 8 AM pricing check at the top of this post, or when an event arrives. Each routine can have up to eight schedules and runs at most once every five minutes. Routines run on the server, so the app can stay closed.

### Teammates

Put up to six bots in a group chat and they take turns in a rotating order; an @mention addresses one bot. Each message you send allows at most three rounds and ten bot messages. Bots can also message each other directly, create new teammates, and hand parts of a task to subagents.

### Plugins and skills

Bundled plugins connect bots to Gmail, Google Calendar, Google Drive, GitHub, Linear, Notion, Slack, Granola and more. You can add your own MCP servers, and save skills: written instructions for work you repeat. Connected accounts are available to every bot.

## How it works

OpenTeam runs as four long-running Docker containers on one host, plus a few one-off setup jobs. The apps are clients; the work happens on the server.

```text
 Desktop app (macOS, Linux) · iPhone app
              │  HTTP(S) + live events
              ▼
           server ──────── PostgreSQL    bots, chats, job queue
              │  wake job
              ▼
           worker                        one turn at a time per bot
              │
              ▼
          computer                       one Linux desktop per bot
            ├── /workspace               files every bot shares
            └── agent runtime            calls your model provider
```

When you send a message, the server stores it in PostgreSQL and queues a wake job for that bot. The worker then claims the bot's turn: one turn at a time per bot, with different bots working in parallel. The computer container runs the model through [Pi](https://github.com/earendil-works/pi), an MIT-licensed agent runtime, and executes the bot's tools there: shell commands, files, the browser and plugins.

![A bot's desktop with Chromium showing a sample date parser fix with a one-line diff and 24 passing tests](/screenshots/linux-code-review.png "A sample code review page opened from the shared /workspace folder, captured September 12, 2026. Image: OpenTeam.")

You choose the model for the server in **Settings → Model**. Sign in with your ChatGPT or Claude plan, connect OpenAI, Anthropic or OpenRouter with an API key, or use any OpenAI-compatible endpoint, including local servers such as Ollama, LM Studio and vLLM.

Three commands cover day-to-day operation. `openteam status` shows the version and the health of each service. `openteam doctor` checks your setup and sends a real request to your model. `openteam update` backs up the database first and rolls back if the new version doesn't start. [How hosting works](/docs/overview/architecture) explains what needs to stay on.

## Open source, GPL-3.0

The code is on [GitHub](https://github.com/raghavpillai/openteam) under GPL-3.0, a copyleft license. You can run, study, change and share it. Anyone who distributes a modified version must publish its source under the same terms; running a changed copy for yourself carries no such duty. Bundled third-party parts keep their own licenses.

The [v0.0.0 release](https://github.com/raghavpillai/openteam/releases/tag/v0.0.0) has five signed command-line builds, a signed Linux AppImage and a notarized macOS installer. OpenTeam is free, with no paid tier and no hosted version. You pay for the machine, your model provider and any services you connect.

## Try OpenTeam

Install the server with the command at the top of this post, then get the desktop app from the [download page](/download) or join the [iPhone beta](https://testflight.apple.com/join/KFBFPkjP). The [quickstart](/docs/getting-started/quickstart) goes from install to a bot's first task. Questions or ideas? [Open an issue on GitHub](https://github.com/raghavpillai/openteam/issues).
