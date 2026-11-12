---
title: An open-source Grok Bot alternative that runs on your own hardware
seoTitle: Open-source Grok Bot alternative on your own hardware
description: Grok Bot runs only in xAI's cloud. OpenTeam is an open-source, self-hosted alternative on your own hardware. How the two compare, feature by feature.
date: 2026-10-10
updated: 2026-11-10
category: Comparisons
image: /blog/images/openteam-desktop.png
imageAlt: The OpenTeam desktop app with a Research bot's chat, a live preview of its Linux screen and a weekday routine
related: grok-bot-vs-meta-muse-vs-openai-dots, introducing-openteam, best-self-hosted-ai-agents
---

**OpenTeam is an open-source Grok Bot alternative: a self-hosted AI agent team where each bot gets its own Linux computer and browser on hardware you control. It's GPL-3.0, uses your ChatGPT or Claude plan, an OpenAI, Anthropic or OpenRouter key, or a local model, and needs no xAI, Cursor or SuperGrok account. Its agent tools are built for compatibility with Grok Bot's, so it will feel familiar.**

We build OpenTeam, so weigh our view accordingly. The Grok Bot facts below come from xAI's docs and Cursor's help and pricing pages as of October 10, 2026, and we haven't benchmarked the two. OpenTeam's agent tools, platform prompt and built-in skills are built for compatibility with Grok Bot's, so much of it will look familiar on purpose.

> **Updated November 10, 2026:** On October 12, xAI replaced Cursor's plans for new customers with The X Subscription, one plan for Grok, Grok Bot, Cursor and X Premium ([xAI](https://x.ai/news/x-subscription)). Grok Bot comes with its Premium plan ($30 a month) and higher tiers, or a Teams seat; the $8 Plus plan doesn't include it ([xAI](https://docs.x.ai/x-subscription/pricing)). Since then, Grok Bot's phone apps can use some apps on your phone, and it can make phone calls. The Grok Bot facts below reflect these changes.

## Grok Bot vs OpenTeam at a glance

Grok Bot facts as of October 10, 2026 (prices and plans as of November 10), from the xAI and Cursor pages linked below. OpenTeam facts are from its v0.0.1 release and docs.

| | Grok Bot | OpenTeam |
|---|---|---|
| Price | The X Subscription's Premium ($30/mo) and up, or a Teams seat; older Cursor plans and SuperGrok links still work; trial credit | Free; you pay for the machine and model usage |
| License | Proprietary | GPL-3.0 |
| Where it runs | xAI's cloud, in the US | Your computer, home server or cloud VM, in Docker |
| Computer per agent | One cloud computer per user, shared by your bots | A persistent Linux desktop per bot, with Chromium and a terminal |
| Models | Chosen per task by Cursor; no picker | Your choice for the server: OpenAI, Anthropic, OpenRouter or a compatible endpoint, local included |
| Multi-agent | Group chats of 2–6 bots; bot-to-bot messages | Group chats of up to 6 bots; bot-to-bot messages |
| Agent tools and skills | Grok Bot's own | Built for compatibility with Grok Bot's |
| Approvals | Auto-review with "Ask first" rules | Cards for email, Slack and texts; handoffs for CAPTCHA, 2FA, payment |
| Channels | Grok Bot apps; Team Bots also in Slack | OpenTeam's desktop and iPhone apps |
| Apps | macOS, Windows, Linux, iPhone, iPad, Android | macOS (Apple silicon), Linux x64; iPhone beta |
| Data location | xAI's cloud; training follows Cursor privacy settings | Your server; prompts go to the model provider you pick |

## What Grok Bot is, as of October 2026

xAI launched Grok Bot in beta on August 11, 2026, describing its bots as "AI teammates you can give real work to," each with its own cloud computer ([xAI](https://x.ai/news/introducing-grok-bot)). That computer is persistent, with a browser, command line and files, and it keeps working with your laptop closed ([xAI](https://docs.x.ai/grok-bot/computer-and-apps)). Each user gets one Firecracker microVM that all of their bots share; in xAI's words, bots "isolate personalities and workspaces, not compute" ([xAI](https://docs.x.ai/grok-bot/teams-and-enterprises)). Signing in for one bot signs in all of them. For passwords, 2FA, CAPTCHAs and payments, the bot hands you the screen.

Bots work in group chats of two to six and message each other directly ([xAI](https://docs.x.ai/grok-bot/chat-and-collaboration)). Skills are reusable instructions shared across your bots. Routines run on a schedule or an event, up to 50 per bot and at least five minutes apart ([xAI](https://docs.x.ai/grok-bot/skills-routines-and-automations)). Team Bots, in public beta since September 28 on Teams and Enterprise plans, give a team one shared bot with its own Slack app ([xAI](https://x.ai/news/team-bots)).

Grok Bot has no standalone price. Since October 12, it comes with The X Subscription's Premium plan at $30 a month, its Super and Ultra tiers, and every paid Teams seat, from $30; the $8 Plus plan doesn't include it ([xAI](https://docs.x.ai/x-subscription/pricing)). New accounts get a trial credit with a 7-day window ([Cursor Help](https://cursor.com/help/grok-bot/plans)). Before that, it came with Cursor Pro at $20 a month, and existing Cursor plans and linked SuperGrok or X Premium+ subscriptions still include it.

## Why people look for a Grok Bot alternative

### 1. It runs only in xAI's cloud

Grok Bot is a hosted service, not software you install. Its computers run in the United States, and Cursor's US-only data residency program "does not apply to Grok Bot by default" ([xAI](https://docs.x.ai/grok-bot/security)). One early reviewer put the trade-off plainly: "Your logins end up on a cloud computer that acts as you" ([Christopher Alarcon](https://christopheralarcon.com/blog/what-is-grok-bot), August 28). That's the product's point, and why some people want the computer at home.

### 2. You can't choose the model

Cursor's help center is direct: "Grok Bot has no per-user or per-request model selection, and there is no model picker." Each task goes to an xAI model or a third-party one from Cursor's sub-processor list ([Cursor Help](https://cursor.com/help/grok-bot/models)). The docs describe no way to bring your own key or run a local model.

### 3. Usage is metered in Cursor's units

On The X Subscription, Grok Bot draws on a weekly pool shared with Cursor and the Grok apps, whose size xAI doesn't publish; past it, work continues on prepaid credit ([xAI](https://docs.x.ai/x-subscription/prepaid-balance)). Older Cursor plans bill extra usage on demand instead ([Cursor Help](https://cursor.com/help/grok-bot/plans)). There's no separate Grok Bot spend cap ([xAI](https://docs.x.ai/grok-bot/teams-and-enterprises)). Some people would rather pay a model provider directly and see every token.

## How OpenTeam works differently

OpenTeam's first public release, v0.0.0, shipped on October 6, and v0.0.1 followed on October 10 ([GitHub](https://github.com/raghavpillai/openteam/releases/tag/v0.0.1)). [Introducing OpenTeam](/blog/introducing-openteam) covers the design. Here's what matters if you're coming from Grok Bot.

### Built for compatibility with Grok Bot

OpenTeam's agent gets the same tool names Grok Bot's bots use on their computer and a platform prompt built to match Grok Bot's. Its built-in skills, for jobs like bookings, shopping, routines and group-chat turns, are adapted to OpenTeam's own tools. The reference was Grok Bot 0.47.0's observable behavior, captured on September 12, 2026.

It's a compatibility layer, not a copy of xAI's service. OpenTeam doesn't claim xAI's server-side instructions or identical output, and because you pick the model, results depend on the model you choose. Here are the two apps; the first screenshot is from xAI's [Grok Bot guide for mobile app development](https://x.ai/bot/guides/grok-bot-for-mobile-app-development).

![The Grok Bot desktop app showing an orchestrator bot messaging other bots and creating a routine, with a sidebar list of specialist bots](/blog/images/grok-bot-multi-bot-handoff.jpg "Grok Bot: an orchestrator bot messages other bots and creates an overnight routine. Screenshot: Grok Bot guide, xAI.")

![The OpenTeam desktop app with a Research bot's chat, a live preview of its Linux screen and a weekday routine](/blog/images/openteam-desktop.png "OpenTeam: a bot's chat, a live view of its own screen and a weekday routine. Image: OpenTeam.")

### Each bot gets its own computer, on your hardware

The server runs in Docker on a Mac, Windows or Linux machine, with 8 GB of RAM recommended ([installation](/docs/getting-started/installation)). Every bot gets a persistent Linux desktop (XFCE, 1280×800) with Chromium and a terminal, which you can watch live and take over ([docs](/docs/usage/computer)). Up to 100 desktops run in one Docker container, and bots can install software with `sudo`.

The difference from Grok Bot is who runs the machine. Work continues on the server with the apps closed, so a Mac mini, home server or VM that stays on keeps your bots going around the clock. To reach it from your phone, use your local network or a VPN such as Tailscale.

![A bot's Linux desktop with a sample vendor comparison open in Chromium and a dock with the browser and terminal](/screenshots/linux-vendor-review.png "A bot's own Linux desktop with sample data, captured September 12, 2026. Image: OpenTeam.")

### Sign-ins, files and memory stay on your server

As in Grok Bot, you sign in once on any bot's screen and every bot is signed in. Bots share a `/workspace` folder and remember facts about themselves and you. For a CAPTCHA, a 2FA code or a payment, a bot sends you a handoff card, and password forms fill without the model seeing the values. Prompts go to the model provider you choose ([privacy](/docs/configuration/privacy)), or stay on your hardware with a local model.

![A sample sign-in page open in Chromium on a bot's Linux desktop](/screenshots/linux-sign-in.png "Sign in once on any bot's screen, and every bot shares the session. Sample data, captured September 12, 2026. Image: OpenTeam.")

### Your model, your team, your schedules

You choose the model for the whole server in **Settings → Model**: a ChatGPT or Claude plan, an OpenAI, Anthropic or OpenRouter key, or any OpenAI-compatible endpoint, including Ollama, LM Studio and vLLM ([models](/docs/configuration/models)).

Group chats hold up to six bots that take turns, with at most three rounds and ten bot replies per message you send. Bots also message each other directly, create teammates and delegate to subagents. Routines run on up to eight schedules, at most every five minutes, or when an email arrives ([routines](/docs/usage/routines)). Bundled plugins include Gmail, Google Calendar, Google Drive, GitHub, Linear, Notion, Slack, Granola and 1Password, plus custom MCP servers.

## Other open-source Grok Bot alternatives

These five are described from each project's README and site as of October 10. Their licenses differ more than their pitches.

- **[MausBot](https://github.com/milind-soni/OpenMausBot)** (OpenMausBot) calls itself "the open-source Grok Bot alternative." It's a chat app for macOS, Windows and Ubuntu where each bot runs the `claude`, `codex` or `grok` CLI on your existing logins, so bots can use different models. Bots work on a cloud Linux desktop, a local VM or, if you opt in, your own computer, with Allow/Deny cards for commands and edits. It's Apache-2.0 except a source-available `enterprise/` directory. Always-on cloud plans start at $29 a month, with model usage billed separately ([MausBot](https://mausbot.com/pricing)).
- **[Rakazo](https://github.com/elie222/rakazo)** describes itself as an "Open-source Grok Bot alternative. Choose your own model and sandbox." It's Apache-2.0 and in beta, with web, desktop, iPhone and Android apps. You self-host it with Docker Compose, and bots get computers in local Docker or from E2B, Daytona, CreateOS or Box.
- **[CopilotKit's OpenBot](https://github.com/CopilotKit/OpenBot)** is MIT-licensed and calls itself "a template, not a product." Each bot gets its own container with Chromium, and a gateway checks every action against your policy and records it. It needs a CopilotKit Intelligence license (a free Developer plan exists), so it suits developers building their own product.
- **[nightly-labs openbot](https://github.com/nightly-labs/openbot)** is a desktop app for macOS, Windows and Linux, with an iPhone app and a server mode. It runs Codex, Claude Code, Grok CLI and others, plus local models, and it can import agents from Grok Bot. Agents run without per-action confirmations. It's source-available under PolyForm Noncommercial 1.0.0, so commercial use needs a separate license.
- **[Cua Spaces and Cua Bots](https://github.com/trycua/cua).** Spaces, for macOS 26 or later, gives agents full macOS or Linux desktops on your Mac, machines you own or your own cloud account, and it's free for individuals. Cua Bots is an example Mac and iPhone app with approvals and rules. Its docs note that "Rules are instructions to the bot, not enforcement" and that routines run while the Mac app is open ([Cua](https://cua.ai/docs/spaces/examples/cua-bots)). Both are source-available under FSL-1.1-MIT.

![MausBot's chat app, where every chat in the sidebar is its own AI bot and one bot's report is open](/blog/images/mausbot-chat-roster.png "MausBot's chat app, with a roster of bots in the sidebar. Image: OpenMausBot (Apache-2.0).")

## Which should you choose?

- **Choose OpenTeam if** you want Grok Bot-compatible bots with their own computers on a server you control and any model provider, including a local one.
- **Choose Grok Bot if** you want xAI to run the computers for you, with a Team Bot in Slack.
- **Choose MausBot if** you want a different model per bot through CLIs you already use.
- **Choose Rakazo if** you want an Apache-2.0 option with a choice of sandbox providers.

Comparing hosted agents too? See [Grok Bot vs Meta Muse vs OpenAI dots](/blog/grok-bot-vs-meta-muse-vs-openai-dots). For Anthropic's agent, see our [Claude Cowork alternative that runs on your own server](/blog/claude-cowork-alternative).

## Frequently asked questions

### Is Grok Bot open source?

No. Grok Bot is a proprietary, hosted xAI service that comes with The X Subscription's Premium and higher plans, and with older Cursor and SuperGrok plans. OpenTeam (GPL-3.0), MausBot and Rakazo (both Apache-2.0) are open-source alternatives.

### Is there an open-source Grok Bot alternative on GitHub?

Yes, several. OpenTeam is at [github.com/raghavpillai/openteam](https://github.com/raghavpillai/openteam) under GPL-3.0. MausBot and Rakazo are Apache-2.0 and CopilotKit's OpenBot is an MIT template; nightly-labs openbot and Cua Spaces are source-available.

### Can I self-host Grok Bot?

No. Its computers run in xAI's cloud in the United States, and there's no self-hosted edition. A bot can run commands on your own computer if you enable and approve that, but the bot still lives in the cloud ([xAI](https://docs.x.ai/grok-bot/computer-and-apps)). OpenTeam is a self-hosted Grok Bot alternative for your own computer, home server or VM.

### How much does Grok Bot cost in India or the UK?

xAI's pricing docs list one set of plans, in US dollars before applicable taxes. Since October 12, 2026, Grok Bot starts at The X Subscription's Premium plan at $30 a month. OpenTeam is free; you pay for the machine and model usage.

### Can I use my own model with Grok Bot?

No. Cursor routes each task to an xAI model or an approved third-party one, with no picker and no local option. OpenTeam lets you choose the provider and model for your server: a ChatGPT or Claude plan, an OpenAI, Anthropic or OpenRouter key, or an endpoint such as Ollama, LM Studio or vLLM.

### Does OpenTeam work like Grok Bot?

Largely, by design. Its agent tools, platform prompt and built-in skills are built for compatibility with Grok Bot 0.47.0's observed behavior. Bots get their own computers, group chats, routines and handoff cards for CAPTCHAs, 2FA and payments, and results depend on the model you choose.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, or `irm https://openteam.so/install.ps1 | iex` in Windows PowerShell, and guided setup follows. The [quickstart](/docs/getting-started/quickstart) walks you through your first bot, and the desktop and iPhone apps are on the [download page](/download).
