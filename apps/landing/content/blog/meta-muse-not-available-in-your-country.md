---
title: Meta Muse isn't available in your country yet. Here's what you can do
seoTitle: Meta Muse not available in your country? Your options
description: Meta Muse is in the US, Canada, Japan and, since October 27, Singapore. What Meta has said, agents sold elsewhere, and self-hosting with OpenTeam.
date: 2026-10-08
updated: 2026-10-28
category: Comparisons
image: /blog/images/openteam-desktop-mobile.png
imageAlt: The OpenTeam desktop app on a MacBook and the iPhone app, both showing a Research bot's vendor comparison and a weekday routine
related: grok-bot-vs-meta-muse-vs-openai-dots, introducing-openteam, best-self-hosted-ai-agents
---

**As of October 28, 2026, Meta Muse is available in the United States, Canada, Japan and Singapore. Meta hasn't announced a date for any other country. Elsewhere, you can wait, use a hosted agent sold where you live, or run OpenTeam, an open-source, self-hosted AI agent team that works wherever your model provider does.**

We build OpenTeam, so weigh our view accordingly. Every Muse fact below links to Meta or to press coverage. The post describes the situation on October 8, 2026, and was updated on October 26 for Muse's launch in Japan and on October 28 for Singapore.

## Meta Muse countries: the US, Canada, Japan and Singapore

Meta [launched Muse on September 8](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), "rolling out in the US on iOS, Android, and muse.ai." Canada followed on September 18 ([iPhone in Canada](https://www.iphoneincanada.ca/2026/09/18/metas-muse-ai-agent-is-now-available-in-canada/)). On September 29, Meta's newsroom described Muse as "a personal AI agent available in the US and Canada" ([Meta](https://about.fb.com/news/2026/09/introducing-muse-small-business/)), and its [terms](https://muse.ai/terms) set the minimum age at 18. Japan followed on October 23, the first country outside North America, on iOS, Android and muse.ai ([Meta](https://about.fb.com/ja/news/2026/10/muse-personal-ai-agent-launches-in-japan/)). Singapore followed on October 27 on the same platforms, with local connector partners such as Grab, Shopee and Singapore Airlines ([Meta](https://about.fb.com/news/2026/10/muse-is-now-available-in-singapore-the-worlds-first-personal-ai-agent-built-for-everyone/)).

Muse runs on the web, iOS, Android and WhatsApp. It's free to start, with paid plans at $20 and $100 a month, and it asks for a payment card at sign-up ([TechCrunch](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/)).

## What Meta has said about other countries

Very little. Meta has published no country list, no timeline and no reason for the order. Its one public hint came with the Canadian launch, a post on X that read "Made it to Canada. Where to next?" ([iPhone in Canada](https://www.iphoneincanada.ca/2026/09/18/metas-muse-ai-agent-is-now-available-in-canada/)).

Other sites offer theories about regulators. Meta hasn't confirmed any of them, so we've left them out.

## Your options if Muse isn't in your country

Availability and US prices come from each vendor's own pages or launch coverage, as of October 8, 2026. The Muse row was updated on October 28.

| Option | Where it's offered | Cheapest way in | Who runs it |
|---|---|---|---|
| Meta Muse | US, Canada, Japan and Singapore | Free tier, card required | Meta |
| Gemini Spark | Where the Gemini app is supported, except the EEA, UK, Switzerland and Nigeria | Google AI Pro or Ultra plan | Google |
| OpenAI dots | ChatGPT Pro or Business Premium; Pro excludes the EEA, UK and Switzerland | ChatGPT Pro, $100/month | OpenAI |
| Claude Cowork | Anthropic's supported countries | Claude Pro, $20/month | Anthropic |
| OpenTeam | Wherever your model provider serves you | Free; you pay for the model and machine | You |

### Wait for Muse

If Muse is the product you want, waiting costs nothing. Meta took ten days to add Canada after the US launch, five more weeks to reach Japan and four days more for Singapore. Neither of the last two announcements said where Muse goes next.

### Use a hosted agent sold in your country

Three hosted agents from other labs are sold outside North America, each with its own map:

- **Gemini Spark** needs a Google AI Pro or Ultra plan and a personal Google Account, and you must be 18 or over ([Google](https://support.google.com/gemini/answer/17094507?hl=en)).
- **OpenAI dots** come with ChatGPT Pro, from $100 a month ([OpenAI](https://learn.chatgpt.com/docs/pricing)), or Business Premium, but Pro subscribers in the EEA, Switzerland and the UK are left out ([SiliconANGLE](https://siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/)).
- **Claude Cowork** comes with paid Claude plans, from Pro at $20 a month ([Anthropic](https://claude.com/pricing)). Anthropic's [supported countries list](https://www.anthropic.com/supported-countries) covers Cowork. Since October 6, Pro and Max tasks run on Anthropic's servers by default ([Anthropic](https://support.claude.com/en/articles/14479288)). We cover that change in our [Claude Cowork alternative that runs on your own server](/blog/claude-cowork-alternative).

All three are run by their vendor, on their vendor's models.

### Run a self-hosted AI agent team

OpenTeam is open-source (GPL-3.0) software that runs a team of AI agents, called bots, on hardware you control: your computer, a home server or a cloud VM. Think of it as an open-source Grok Bot alternative you host yourself. It's [a self-hosted AI agent team where every bot gets its own computer](/blog/introducing-openteam): a Linux desktop with a Chromium browser and a terminal.

OpenTeam has no region check of its own. It works wherever your [model provider](/docs/configuration/models) serves you: an OpenAI, Anthropic or OpenRouter API key, or any OpenAI-compatible endpoint. The [Anthropic](https://www.anthropic.com/supported-countries) and [OpenAI](https://developers.openai.com/api/docs/supported-countries) lists both include India, the UK, Australia, Singapore, the UAE and every EU country. Check yours first, because the provider's rules still apply. OpenAI warns that access from outside its list "may result in your account being blocked or suspended." If your country isn't listed, a local model through Ollama, LM Studio or vLLM keeps model requests on your own hardware.

Self-hosting also moves the responsibility to you. Your server stores conversations, files, memory and sign-ins, and your model provider still sees what bots send it ([privacy](/docs/configuration/privacy)). Backups, updates, who can reach the server, and any duties under data-protection law such as the GDPR are yours, not a vendor's.

![OpenTeam's desktop and iPhone apps showing a Research bot's vendor comparison and a weekday pricing routine](/blog/images/openteam-desktop-mobile.png "The desktop app and the iPhone beta connect to the same server. Image: OpenTeam.")

## What Muse does better

- **It's free to start.** Meta pays for the model and the cloud computer, and calls Muse "free for most of what people need" ([Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)). OpenTeam is free software, but you pay a model provider and run the machine.
- **It's phone-first.** Muse works on iOS, Android, the web and WhatsApp. OpenTeam's desktop apps are for macOS on Apple silicon and Linux x64 only, the iPhone app is a TestFlight beta, and there's no Android app.
- **There's no setup.** Muse is an app download. OpenTeam needs Docker, a host machine (8 GB of RAM recommended) and a model provider. If that host is a laptop that sleeps, your bots stop until it wakes.
- **Meta's integrations.** Muse checks out with Link by Stripe and its purchase protections, and at Connect Meta announced retail connectors such as Walmart, Best Buy and Sephora ([Meta](https://about.fb.com/news/2026/09/the-biggest-news-from-connect-2026/)). OpenTeam's plugins cover work tools like Gmail, GitHub, Notion and Slack, with no shopping partners.
- **A check on outgoing requests.** A separate Sentinel agent must approve anything Muse sends to the internet ([Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)). OpenTeam has no approval step; bots act directly, with passwordless `sudo` in their shared container. It also runs one model for every bot on a server and supports one human account.

![Muse chat in which the agent asks the user to allow or deny an $80 order, with the card and total shown](/blog/images/meta-muse-approval-prompt.png "Muse asks before it places an order. Screenshot: muse.ai, Meta.")

If you're in the US, Canada, Japan or Singapore and want an agent on your phone in two minutes, Muse is the easier choice.

## Frequently asked questions

### Is Meta Muse available in India?

No. Meta hasn't announced a date for India. Its October 1 India newsroom post said Muse is coming to Meta's AI glasses "in the coming months," but it didn't say Muse would launch in India ([Meta](https://about.fb.com/news/2026/10/announcing-ranveer-singh-as-brand-ambassador-for-ray-ban-and-ray-ban-meta-in-india-along-with-exciting-new-updates-to-our-ai-glasses/)). India is on Anthropic's and OpenAI's lists and isn't excluded from Gemini Spark.

### Is Meta Muse available in the UK or the EU?

No, and Meta has given no date for the UK, Germany, France or any other EU country. Gemini Spark and Pro dots exclude them too, which leaves Claude Cowork and self-hosting as the personal options above.

### Is Meta Muse available in Singapore, Australia or the UAE?

In Singapore, yes, since October 27, 2026, on iOS, Android and muse.ai ([Meta](https://about.fb.com/news/2026/10/muse-is-now-available-in-singapore-the-worlds-first-personal-ai-agent-built-for-everyone/)). Not in Australia or the UAE, and Meta hasn't given a date for either. Neither is excluded from Gemini Spark or Pro dots, and both are on Anthropic's and OpenAI's lists.

### Is Meta Muse available in Japan?

Yes, since October 23, 2026, on iOS, Android and muse.ai ([Meta](https://about.fb.com/ja/news/2026/10/muse-personal-ai-agent-launches-in-japan/)).

### Is Meta Muse available in Canada?

Yes, since September 18, 2026, for people 18 and over.

### Can I use a VPN to get Meta Muse?

We don't recommend it. Meta offers Muse only in the US, Canada, Japan and Singapore, and sign-up asks for a payment card. The Muse terms let Meta "suspend or terminate your access to Muse or its features… at any time, for any reason, without prior notice" ([Muse terms](https://muse.ai/terms)). You'd be giving your email, calendar and sign-ins to an agent Meta hasn't launched under your country's privacy law, on an account you could lose mid-task.

### Is there a free, open-source alternative to Meta Muse?

Yes, with a caveat. OpenTeam is free and open source under GPL-3.0, but running it isn't free: you pay for the machine and the model provider. With a local model, the model cost becomes your own hardware; pick one that supports tool calling, because bots rely on it. Where Muse is available, its free tier is the cheaper way to start.

## Try OpenTeam

Install the server on macOS or Linux:

```sh
curl -fsSL https://openteam.so/install | sh
```

On Windows, run `irm https://openteam.so/install.ps1 | iex` in PowerShell. The [quickstart](/docs/getting-started/quickstart) covers setup, and the desktop apps are on the [download page](/download).
