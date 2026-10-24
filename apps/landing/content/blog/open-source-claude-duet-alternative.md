---
title: "OpenTeam vs Claude Duet: an open-source Claude Duet alternative you run yourself"
seoTitle: "Open-source Claude Duet alternative: OpenTeam vs Claude Duet"
description: Claude Duet is US-only, waitlisted and runs in Anthropic's cloud. OpenTeam is an open-source, self-hosted alternative you can run today, with any model.
date: 2026-10-21
category: Comparisons
image: /blog/images/claude-duet-scorecard.png
imageAlt: A comparison table of Claude Duet and OpenTeam covering availability, source code, where each runs, models, agents, check frequency, browser takeover, texts and calls, local files and usage limits
related: grok-bot-vs-meta-muse-vs-openai-dots, claude-cowork-alternative, ai-imessage-assistant
---

**OpenTeam is an open-source Claude Duet alternative: a self-hosted team of proactive AI agents. Your bots brief you each morning, watch your inbox on a schedule you set, and wait for your Send before an email goes out. It's GPL-3.0 and runs on hardware you control, with Claude or any other model. There's no waitlist and no US-only rule.**

Anthropic opened Claude Duet on October 21, 2026, as a research preview for Pro and Max subscribers in the US. We build OpenTeam, so weigh our view accordingly. Every Duet fact below links to Anthropic's announcement, product page or help center as of launch day. We haven't used Duet, because access is by waitlist.

![A comparison table of Claude Duet and OpenTeam: Duet is for US Pro and Max plans by waitlist, closed, in Anthropic's cloud, Opus 5.5 only, one agent, checking every few hours; OpenTeam is open to anyone, GPL-3.0, on your own machine, with any model and a team of bots with their own computers](/blog/images/claude-duet-scorecard.png "Where Claude Duet and OpenTeam differ, as of October 21, 2026. Diagram: OpenTeam.")

## Claude Duet vs OpenTeam at a glance

Duet facts are from [Anthropic's announcement](https://claude.com/resources/articles/claude-duet), [product page](https://claude.com/product/claude-duet) and [help center](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet), checked October 21, 2026. OpenTeam facts are from its [docs](/docs/getting-started/quickstart) and code. Where Anthropic hasn't published a figure, the cell says so.

| | Claude Duet | OpenTeam |
|---|---|---|
| Price | Included with Claude Pro ($20/mo) or Max (from $100/mo) during the preview | Free; you pay for the machine and model usage |
| Availability | US only, Pro and Max, by waitlist | Any country, today |
| License | Proprietary | GPL-3.0 |
| Where it runs | Anthropic's cloud | Your computer, home server or cloud VM |
| Models | Claude Opus 5.5 only | One per server: Claude, GPT, OpenRouter models or a local model |
| Agents | One agent: a main thread plus topic channels | A team of bots; group chats of up to 6 |
| Computer | A cloud VM with a browser you can't watch | A Linux desktop per bot that you can watch and take over |
| Morning brief | Built in | A routine you write in one sentence |
| Checks your apps | "Every few hours"; interval not published | Exact times, intervals down to 5 minutes, or new mail within about a minute |
| Approvals | Before every send, payment, signature or deletion | Email and Slack drafts wait for your Send; no approval step for other actions |
| Passwords | Typed into a separate form, kept out of Duet's chat | Typed into a secure form the model can't read back |
| Texts and calls | Doesn't text other people or make calls | Texts from your Mac's Messages; calls through call4me |
| Your own computer | Can't see your files | Reads and copies files through the desktop app |
| Connectors | 6,000+ connectors and plugins in the Claude Marketplace | 16 bundled plugins plus any MCP server |
| Usage limits | Counts toward your plan's five-hour and weekly limits | None from OpenTeam; your provider bills per token |
| Apps | iPhone and Android for invited users; web | macOS (Apple silicon), Linux x64; iPhone beta |
| Your data | Anthropic's cloud; region not published | Your server; your model provider sees what bots send it |

## What Claude Duet is, as of October 21, 2026

Anthropic calls Duet "a new app where Claude works as a proactive agent. It comes to you with what needs your attention, completes tasks you ask of it, keeps working even when you step away, and checks with you before it acts on your behalf" ([Anthropic](https://claude.com/resources/articles/claude-duet)). It's built "for professionals and small business owners with more on their plates than they can track."

Each morning, Duet "looks across your email and calendar, picks what most needs your attention, and can start the first steps, like drafting replies for you to review" ([help center](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)). Through the day it checks your connected accounts "every few hours, because checking nonstop would use up your plan's limits much faster." It works in "a virtual machine with its own browser," so your phone and laptop can be off. Bigger jobs, such as a financial model, a deck or a dashboard, come back as files in its Make tab.

Before Duet "sends a message, makes a payment, signs a document, or deletes anything, it shows you exactly what it's about to do and waits for your approval." Some actions are off-limits even with approval, such as trading securities or moving money between accounts. Passwords go into a separate form on your device, and two classifiers screen its actions and guard against leaks of sensitive information.

It runs only on Claude Opus 5.5: "You can't choose a model." It's an app for iPhone and Android, plus the web at claude.ai, separate from the main Claude app. Mike Krieger of Anthropic wrote that Opus 5.5 "was our first model with the judgment to be proactive in the right ways" ([X](https://x.com/mikeyk/status/2112986418503110772)).

![Three Claude Duet phone screens from Anthropic's product page: a morning brief listing hiring, a contract renewal, a permit and a fundraising meeting; an email draft with Send and Not now; and a $640 permit payment with Approve and Not now](/blog/images/claude-duet-app-screens.png "Duet's morning brief, email approval and payment approval, from Anthropic's sample business. Screenshot: Claude Duet product page, Anthropic.")

## Why look for a Claude Duet alternative

### 1. It's US-only, Pro and Max only, and waitlisted

Duet needs a Pro or Max plan, a Claude account in the US and an invitation from the waitlist ([help center](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)). Team and Enterprise plans aren't included yet, and access "opens in waves." Its payments through Link require a US payment method too ([Anthropic](https://support.claude.com/en/articles/17666484-how-to-use-link-by-stripe-with-claude-duet)). If you're in the UK, Canada, India, Australia or the EU, there's no date.

### 2. Your inbox, calendar and sign-ins live in Anthropic's cloud

Duet's computer, its browser sessions and your connected accounts all sit on Anthropic's servers, and Anthropic hasn't published a region for Duet. Disconnecting an app stops new access, but "memory of past information from earlier conversations is kept." On launch day, one Hacker News commenter put the alternative bluntly: "the infrastructure via which the agents do useful work has to be open source, and the data and learnings and SOPs they produce have to be yours" ([HN](https://news.ycombinator.com/item?id=50187588)).

### 3. One model, one agent

Duet runs Opus 5.5 and nothing else. You get one agent with one main thread and topic channels that share its memory. Another commenter asked why they'd "pick one where I'm locked into a specific model family" for an agent that's meant to stay with you ([HN](https://news.ycombinator.com/item?id=50186226)).

### 4. Background work spends your plan's limits

Duet "uses your plan's usage limits, including the five-hour session and weekly limits." The morning brief and the check-ins count too, "so you may reach your limits sooner than with chat alone" ([help center](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)). The more you want it to watch, the less Claude you have left for everything else.

### 5. You can't see it work, and it can't reach past the browser

Anthropic's own limits list says: "You can't watch Claude Duet work in its browser or take over the browser." Duet "can't see … the files on your computer," and it "doesn't make phone calls or send text messages to other people." It can miss something that arrives between checks.

## How OpenTeam works instead

OpenTeam is software you install. The server runs in Docker on a Mac, Windows or Linux machine, with 8 GB of RAM recommended ([installation](/docs/getting-started/installation)). You talk to your bots from the desktop app on macOS or Linux, or from the iPhone beta. Every bot gets its own Linux computer on that server, and everything it learns stays on your disk.

![Two columns: Claude Duet, where the app on web or iPhone talks to one Duet agent, your connected apps and Opus 5.5 inside Anthropic's cloud; and OpenTeam, where Mac, Linux and iPhone apps reach your own server holding a team of bots with Linux computers, routines, memory, sign-ins and plugins, which sends prompts to a hosted or local model you pick](/blog/images/claude-duet-where-each-runs.png "Duet is a service in Anthropic's cloud. OpenTeam runs on your machine and sends prompts to the model you choose. Diagram: OpenTeam.")

## Head to head: Claude Duet vs OpenTeam

### The morning brief

Duet's brief is built in. In OpenTeam, you ask a bot for one in plain words, and it saves a routine. A routine is saved instructions that run on a schedule or an event, on the server, with the apps closed ([routines](/docs/usage/routines)). Here's the whole setup:

```text
Every weekday at 7:30 AM, check my Gmail, Calendar and Slack. Send me a
short brief of what needs my attention today. If nothing does, stay quiet.
```

The bot creates the routine and shows it in the bot's routine panel, where you can edit the wording, add schedules or press **Test run**.

![The OpenTeam desktop app: a Chief of Staff bot's chat where the user asks for a weekday 7:30 AM brief of Gmail, Calendar and Slack, a Created routine line, and a Routine panel showing Morning brief, On weekdays at 7:30 AM, and No runs yet](/blog/images/openteam-morning-brief-routine.png "One sentence creates the routine; the panel shows its schedule and run history. Sample data. Image: OpenTeam.")

"Stay quiet" is enforced by design. A bot reaches you only when it deliberately sends a message, so a run that finds nothing posts nothing. In the sample below, Monday's run found nothing and sent nothing.

![The OpenTeam chat with the morning brief routine: a one-item brief on Friday, nothing on Monday, and on Tuesday a four-item brief covering a moved meeting, a customer email, an unpaid invoice and a Slack review request, ending with an offer to draft a reply](/blog/images/openteam-morning-brief-chat.png "Friday's brief had one item, Monday's run stayed quiet, and Tuesday's found four. Sample data. Image: OpenTeam.")

You control what counts. Write "skip newsletters," "only clients at @northwind.example" or "flag invoices over $1,000," and the bot follows it. You can do the same with Duet by telling it what you want to hear about. The difference is that OpenTeam's rules sit in a routine you can read and edit.

![A six-step flow: at 7:30 AM on weekdays the routine wakes, the bot checks Gmail, Calendar and Slack, and judges what needs you; it stays quiet if nothing does, or sends a short brief; you reply, a draft card waits for Send, and the server sends it from your Gmail](/blog/images/claude-duet-morning-brief.png "A morning brief in OpenTeam, from the schedule to a sent reply. Diagram: OpenTeam.")

### Watching your apps through the day

Duet checks "at set intervals, so something urgent can arrive between checks" ([help center](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)). You can tell it "what you want to hear about and how often," but Anthropic doesn't publish the interval, and every check counts toward your plan's limits.

OpenTeam gives you the clock. A routine can have up to eight schedules, as exact times in your time zone or intervals as short as every five minutes. It can also start on an event instead: a GitHub issue, a Slack message, a Linear update, a Sentry or PagerDuty alert, a Microsoft Teams message, or any signed webhook.

For email, the [Email plugin](/docs/integrations/email) checks each connected mailbox about once a minute. A routine can watch for chosen senders, and by default only mail that passes DMARC fires it, so forged senders are ignored. It connects over IMAP, so Gmail and Google Workspace accounts need an app password. Outlook and Microsoft 365 can't connect this way, since Microsoft doesn't allow app passwords.

![Two lanes: Claude Duet checks at set intervals every few hours, quoting Anthropic that something urgent can arrive between checks; OpenTeam's email routine sees a 10:12 email by about 10:13, reads and decides, and messages you with a reply draft](/blog/images/claude-duet-urgent-email-timing.png "An urgent email at 10:12 AM: Duet sees it at its next check, OpenTeam's email routine within about a minute. Diagram: OpenTeam.")

### Doing the work: one cloud VM, or a computer per bot

Duet does its work in a cloud VM with its own browser, out of sight. Its Tasks tab shows what it's working on, and Anthropic says it "can't yet show you its browser." For now, you see results and approval requests, not the screen.

In OpenTeam, every bot has its own persistent Linux desktop with Chromium and a terminal ([computer](/docs/usage/computer)). You can open any bot's screen and watch it work live, then take control with a click. When a bot hits something only you can do, it posts a card asking you to take over, and you hand it back when you're done.

Bots share a `/workspace` folder and website sign-ins: sign in to a site once, on any bot's screen, and every bot is signed in. They build things there too. A bot can write a web app, run it on its own computer and test it in its own browser. OpenTeam has no built-in way to publish what it builds, though.

![A bot's Linux desktop with a sample vendor comparison open in Chromium and a dock with the browser and terminal](/screenshots/linux-vendor-review.png "Each bot has its own desktop, which you can watch and take over. Sample data. Image: OpenTeam.")

### Reaching past the browser: texts, calls and your own computer

This is where Duet stops by design: it doesn't text other people, doesn't make calls and can't see your computer. OpenTeam bots can do all three.

- **Texts.** With the desktop app on your Mac, bots can read and send Messages, iMessage and SMS, and start new conversations. For a Mac that stays on, the iMessage (SSH) plugin can reply in existing chats once you turn replies on. Our [guide to an AI iMessage assistant](/blog/ai-imessage-assistant) covers both paths.
- **Phone calls.** Add [call4me](https://call4.me/) as a custom MCP server and a bot can phone a business for you, at $0.25 a minute. See [how to make phone calls from OpenTeam](/blog/ai-agent-phone-calls).
- **Your own computer.** The desktop app connects your Mac or Linux PC, so bots can run commands, read your files and copy them to and from their `/workspace`. On a Mac they can also read your contacts and import your Chrome sign-ins into their browser.

Bots don't get your screen, mouse or keyboard; they work through commands and files. Keep the desktop app open while they use your computer.

### Checks before it acts

Duet has the broader approval rules today. It stops before every message, payment, signature and deletion, and an action classifier and a sensitive-information classifier sit on top. OpenTeam's checks cover the things that leave your hands most often, and the email check is enforced in code rather than by asking the model nicely.

By default, when a bot writes an email or a Slack message, it appears as a draft card in the chat. You can edit it, then choose **Send** or **Discard**. For email, bots have no send tool at all: the send action is reserved for the server and only runs when you press Send ([email](/docs/integrations/email)). You can let chosen recipients skip the card, or turn drafts off for a bot you trust.

![An OpenTeam Gmail reply card in a Chief of Staff chat, showing From, In reply to, To, Cc and Subject fields, a short reply to Lena Park, and Send and Discard buttons](/blog/images/openteam-email-draft-approval.png "A reply waits for Send. Bots can't send email themselves. Sample data. Image: OpenTeam.")

For other actions, OpenTeam bots act directly. They don't stop before deleting a file, buying something on a site where a card is saved, or texting from your Mac. If you want a person in the loop for those, say so in the routine ("draft, don't send"), and don't save cards in bot browsers.

### Passwords and payments

Both keep passwords away from the model in the same way. In Duet, you type a password "into a separate form on your device," which sends it straight to the browser. In OpenTeam, a bot asks you to fill a secure form, and the server fills it into the page on the exact site shown. The values are write-only, so the model never gets them back. Card numbers work the same way.

Two caveats are worth knowing. Values a bot reads from 1Password, and two-factor codes it fetches, appear in the conversation. And Duet can pay through Stripe's Link, which asks you to approve the spend and pays with a one-time card scoped to the merchant and amount ([Anthropic](https://support.claude.com/en/articles/17666484-how-to-use-link-by-stripe-with-claude-duet)). It can also check out with Shopify's Shop Pay. OpenTeam offers neither.

### Models: Opus 5.5, or whatever you choose

Duet runs only on Opus 5.5 and decides how much effort a job needs. OpenTeam serves one model to all bots on a server, and you choose it ([models](/docs/configuration/models)):

- **Claude, through an Anthropic API key.** OpenTeam loads the model list live from Anthropic. On the API, Opus 5.5 costs $4 per million input tokens and $20 per million output tokens ([Anthropic](https://platform.claude.com/docs/en/about-claude/models/overview)).
- **OpenAI or OpenRouter**, through an API key.
- **A local model** through Ollama, LM Studio or vLLM, so prompts never leave your hardware.

If you already pay for Claude Max, there's a detail worth knowing. Since October 7, Max includes monthly Claude Platform API credits: $100 on Max 5x and $200 on Max 20x. Anthropic says "the credits don't change your usage limits in Claude, Claude Code, or Claude Cowork" ([Anthropic](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)). An API key from the Console organization you link draws on that balance. The credits expire monthly, and past them the key bills normally.

The limit is real: every bot on a server uses the same model, and smaller local models drive tools less reliably than Opus-class ones.

### One agent, or a team

Duet is one agent. You talk to it in one main thread and can start channels for topics, which share its memory.

OpenTeam is a team. You can run a Chief of Staff, a Research bot and a Finance bot, each with its own computer, chat, memory and routines. Put up to six in a group chat and they take turns, with limits of three rounds and ten bot replies per message you send. Bots can also message each other directly and hand work to helpers. [How AI agents talk to each other](/blog/how-ai-agents-talk-to-each-other) covers the design.

### Your data and memory

Duet keeps what it learns in your Claude account and carries over "your memory, skills, and connected apps." Anthropic hasn't published a region or a Duet-specific training statement; its help center says Duet uses your Claude account settings.

OpenTeam stores conversations, files, memory, routines and website sign-ins on your server ([privacy](/docs/configuration/privacy)). Bots remember facts about you and themselves, and you can review and delete them. Your model provider still receives what each task needs, and connected services see their own requests, unless the model runs locally. OpenTeam's server, worker, computer, CLI and desktop app include no analytics SDK.

### Price and limits

Duet is included with Pro ($20 a month, or $17 on annual billing) and Max (from $100 a month) during the preview, at no extra cost ([pricing](https://claude.com/pricing)). Its background work counts toward your plan's limits, and you get one limit reset when you're admitted.

OpenTeam is free. You pay for the machine, which can be one you already own, and for model usage at your provider's rates. With a local model, model usage costs nothing beyond the hardware. Past the five-minute minimum for schedules, OpenTeam doesn't limit how often your bots check things; your model bill does.

## Build Claude Duet's best features in OpenTeam

You can have a working morning brief tonight, wherever you live.

1. **Install the server** on a machine that stays on: a Mac mini, a home server or a small cloud VM. Run `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, or `irm https://openteam.so/install.ps1 | iex` in Windows PowerShell, and follow the guided setup ([quickstart](/docs/getting-started/quickstart)).
2. **Connect a model.** An Anthropic API key gets you Claude; any provider in the list works.
3. **Connect your apps.** In the app's **Marketplace**, add Gmail, Google Calendar and Slack. Google's plugins use your own OAuth app in Google Cloud, a one-time setup that the [Google guide](/docs/integrations/google) walks through. The Slack plugin needs an HTTPS address for your server and your own internal Slack app ([plugins](/docs/usage/plugins)).
4. **Ask for the brief.** Send a bot the routine above, then press **Test run** in its routine panel to see one now.
5. **Add an urgent-mail watcher.** Connect the Email plugin and ask: "When an email arrives from @northwind.example, tell me if it needs a reply today, and draft one."
6. **Reach it from anywhere.** Use your home network or a VPN such as Tailscale, so you can check briefs away from home ([remote access](/docs/configuration/remote-access)).

## Where Claude Duet is ahead today

- **Zero setup.** You join a waitlist, install an app and connect accounts; Anthropic runs everything. OpenTeam needs Docker, a machine that stays on, a model key or local model, your own Google Cloud app for Google accounts, and some comfort with a terminal.
- **Phone-first apps.** Duet has iPhone and Android apps with push notifications. OpenTeam's iPhone app is a TestFlight beta, and its push alerts need Apple credentials on your server that most people won't have. There's no Android or web app, and desktop apps exist only for macOS on Apple silicon and Linux x64.
- **Approvals for everything consequential.** Duet stops before sends, payments, signatures and deletions, and its classifiers screen actions and sensitive data. Anthropic says red teams and an outside firm tested it. OpenTeam's approval step covers email and Slack drafts.
- **Payments and breadth.** Link payments with one-time cards, Shop Pay checkout, and over 6,000 connectors and plugins, including QuickBooks, HubSpot and Docusign. OpenTeam bundles 16 plugins plus any MCP server.
- **Judgment out of the box.** Anthropic designed Duet around Opus 5.5 and built it "to decide what needs you, what can wait, and when to check with you first," with your Claude memory, skills and connectors carried over. In OpenTeam, results depend on the model you pick and the instructions you write, and one human account per server is the limit.

If you're in the US, on Pro or Max, and want a proactive agent on your phone with no setup, join Duet's waitlist. Everyone else can run OpenTeam today.

## Other Claude Duet alternatives

- **[OpenAI dots](https://learn.chatgpt.com/docs/dots)** are always-on ChatGPT agents, each with its own cloud computer. Personal dots need ChatGPT Pro and exclude the EEA, UK and Switzerland. See [Grok Bot vs Meta Muse vs OpenAI dots](/blog/grok-bot-vs-meta-muse-vs-openai-dots).
- **[Meta Muse](https://www.meta.com/help/subscriptions/1021145227643680/)** has a free tier and paid plans from $20 a month, in the US and Canada. If you're elsewhere, see [Meta Muse not available in your country?](/blog/meta-muse-not-available-in-your-country).
- **Grok Bot** comes with Cursor Premium ($30 a month) and higher plans, in xAI's cloud. See our [open-source Grok Bot alternative](/blog/open-source-grok-bot-alternative).
- **Claude Cowork** is Anthropic's agent inside the main Claude app. It waits for you to start a chat rather than coming to you. See our [Claude Cowork alternative that runs on your own server](/blog/claude-cowork-alternative).
- **Other open-source options** include MausBot, Rakazo, Hermes Agent and OpenClaw, compared in [best self-hosted AI agents](/blog/best-self-hosted-ai-agents).

## Which should you choose?

- **Choose OpenTeam if** you're outside the US, want your agents and their sign-ins on your own machine, want Claude or any other model including a local one, want a team of bots you can watch, or want routines that run on your exact schedule without spending a plan's limits.
- **Choose Claude Duet if** you're in the US on Pro or Max, want no setup, need Android, or want approval prompts on every payment and deletion.
- **Choose OpenAI dots or Meta Muse if** you're already deep in ChatGPT or Meta's apps and live where they're offered.

## Frequently asked questions

### Is Claude Duet open source?

No. Claude Duet is a proprietary, hosted Anthropic service. The `claude-duet` project on [GitHub](https://github.com/EliranG/claude-duet) is unrelated: it lets two developers share one Claude Code session. OpenTeam is an open-source alternative under GPL-3.0, at [github.com/raghavpillai/openteam](https://github.com/raghavpillai/openteam).

### Is there an open-source Claude Duet alternative?

Yes. OpenTeam gives you a proactive morning brief, routines that watch your apps, email drafts that wait for Send, and bots with their own computers, all self-hosted. It runs with Claude through an Anthropic API key, or with OpenAI, OpenRouter or a local model.

### Is Claude Duet available in the UK, Canada, India or the EU?

No. "Claude Duet is available in the US only during the research preview," and Anthropic hasn't announced dates elsewhere ([help center](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)). OpenTeam runs in any country; your model provider's availability is the only regional limit.

### How much does Claude Duet cost?

There's no separate price during the preview. Duet is included with Claude Pro ($20 a month) and Max (from $100 a month), and its background checks count toward your plan's five-hour and weekly limits. OpenTeam is free; you pay for the machine and model usage.

### Can I self-host Claude Duet?

No. Duet runs on Anthropic's cloud computers, and Anthropic offers no self-hosted edition or API for it. OpenTeam is a self-hosted Claude Duet alternative for your own computer, home server or cloud VM.

### Can I use Claude with OpenTeam?

Yes, with an Anthropic API key, billed per token by Anthropic. Claude Max plans include monthly API credits that work with a key from the Console organization you link, separate from your plan's usage limits. One model serves every bot on a server.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, or `irm https://openteam.so/install.ps1 | iex` in Windows PowerShell, and guided setup follows. The [quickstart](/docs/getting-started/quickstart) walks you through your first bot, and the desktop and iPhone apps are on the [download page](/download).
