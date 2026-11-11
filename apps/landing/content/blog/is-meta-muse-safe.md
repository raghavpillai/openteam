---
title: "Is Meta Muse safe? What it can see, and what self-hosting changes"
seoTitle: "Is Meta Muse safe? Privacy, permissions and self-hosting"
description: Muse has strong guardrails, training on by default and a rocky first month. What it sees, what self-hosted AI agents like OpenTeam change, and a checklist.
date: 2026-10-25
updated: 2026-11-10
category: Comparisons
image: /blog/images/meta-muse-vs-openteam-data.png
imageAlt: "Muse keeps your data in a VM in Meta's cloud with training on by default; a self-hosted OpenTeam server keeps it on your machine and sends prompts to the model you pick"
related: meta-muse-not-available-in-your-country, grok-bot-vs-meta-muse-vs-openai-dots, ai-agent-own-computer
---

**Meta Muse is reasonably safe to try if you connect it carefully, but it asks for more trust than most apps. Its agent lives in a dedicated cloud VM behind a gatekeeper it can't override. Meta still trains on your chats by default and can reach your data. OpenTeam, an open-source, self-hosted AI agent team, moves that data to your own server.**

We build OpenTeam (GPL-3.0), so weigh our view accordingly. On October 25, 2026, Muse was offered in the US, Canada and, since October 23, Japan ([Meta](https://about.fb.com/ja/news/2026/10/muse-personal-ai-agent-launches-in-japan/)). Singapore followed on October 27 ([Meta](https://about.fb.com/news/2026/10/muse-is-now-available-in-singapore-the-worlds-first-personal-ai-agent-built-for-everyone/)), and on November 10 we added Muse's newer features below. We haven't tested it ourselves.

## Meta Muse vs a self-hosted agent team at a glance

Muse facts come from Meta's [launch post](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), [engineering post](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), [help center](https://www.meta.com/help/superintelligence/1047255454427887/) and [privacy policy](https://muse.ai/privacy), checked October 25, 2026. OpenTeam facts come from its [docs](/docs/configuration/privacy) and code.

| | Meta Muse | OpenTeam (self-hosted) |
|---|---|---|
| Where it runs | A Linux VM per person, in Meta's cloud | Docker on your computer, home server or cloud VM |
| Who stores your data | Meta, in your VM, backed up continuously | Your server; backups are yours |
| Who else can reach it | Meta, "when necessary to support, secure or operate the service" | Whoever you let onto your server |
| Training on your data | On by default; opt out in Data controls | None by OpenTeam; you choose the model provider |
| Approvals | Sentinel allows, denies or asks, per your settings | Email and Slack drafts and texts wait for your Send |
| Sign-ins | A store the agent can't read | Secure forms fill passwords without the model seeing them |
| Prompt-injection defenses | Trained model, classifiers, Sentinel, egress checks | Tool results labeled as untrusted data, plus prompt rules |
| Open source | No | Yes, GPL-3.0 |
| Who patches it | Meta | You, with `openteam update` |
| Price and regions | Free tier, $20 and $100 plans; US, Canada, Japan, Singapore | Free; you pay for hardware and model use; any country your provider serves |

## What Muse can see and do once you connect it

Meta launched Muse on September 8. It can "open a browser, fill out forms, and negotiate on their behalf," and keeps working after you close the app ([Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)). Its reach depends on what you connect:

- **Your accounts.** Connectors cover email, calendars, payments, health, the smart home, dining and shopping ([TechCrunch](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/)). Facebook, Instagram and Threads "are connected automatically if you have your accounts in the same Accounts Center" ([Meta](https://www.meta.com/help/superintelligence/1687253048996149/)). Muse can also build connectors for services with an API, and "Meta doesn't review custom connectors."
- **The web.** A Chromium browser in its VM that you can watch and take over.
- **Your Mac.** The Mac app "works with your desktop computer files, apps and browser tabs" ([Meta](https://ai.meta.com/muse/)). Reading Messages needs Full Disk Access plus a Messages connector, Meta says ([TechCrunch](https://techcrunch.com/2026/09/30/meta-disputes-claim-that-muse-read-a-users-private-messages-without-permission/)).
- **Your money.** Checkout can run through Link by Stripe, which issues a single-use card number per purchase.
- **What it remembers.** Memory files such as MEMORY.md, which you can edit ([Meta](https://www.meta.com/help/superintelligence/2225571704857152/)), and "a page for every person in the user's life," refreshed hourly ([Wired](https://www.wired.com/story/muse-creates-detailed-profiles-of-all-your-friends-and-family/)).
- **New since this post.** On November 5, US users got voice conversations with Muse ([Meta](https://about.fb.com/news/2026/11/introducing-muse-ai-voice-expressive-avatars/)). On November 6, Meta added spaces, custom views that draw on your accounts, such as "a school dashboard that finds the events relevant to your kids in school emails and adds them to your calendar" ([Meta](https://about.fb.com/news/2026/11/introducing-spaces-customize-muse-app/)).

Connecting email "won't download your whole inbox (unless you tell it to)," and the email connector filters out one-time codes and password-reset links ([Meta](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)).

![Muse's cloud VM holds the agent, a browser and a credential store; Sentinel gates its reach to email, Meta apps, websites, payments, your Mac and phone, and unreviewed custom connectors](/blog/images/meta-muse-what-it-can-reach.png "Everything that leaves Muse's VM passes through Sentinel, but the list grows with every connector. Diagram: OpenTeam, from Meta's documentation.")

## How Meta says it protects you

"The right mental model is two isolated security domains on one box, not an LLM powered agent with root," Meta's engineering post says. The agent runs in a locked-down container inside your VM. Credentials sit outside it, and the agent sees only stand-in tokens, swapped for real ones at the network edge.

The centerpiece is Sentinel, a separate agent that "is the sole permission authority for connector actions and network egress." It allows a request, denies it or asks you in a dialog outside the chat. Under **Settings → Permissions**, you choose whether Muse asks for "some actions" or every one, and grant each approval once, per task, per site or always ([Meta](https://www.meta.com/help/superintelligence/1385290430137537/)). There's an **Activity log**, a forget skill and a **Reset** that deletes everything. A bug bounty pays up to $300,000.

On data, in Meta's words:

- **Training.** "This setting is on when you first use Muse." Meta first strips personal details "like names, email addresses, phone numbers and Social Security Numbers," and connector data used in tasks falls under the same switch ([privacy policy](https://muse.ai/privacy)).
- **Ads.** "Muse doesn't share your conversations or the data in your virtual machine with Meta ad systems." But sites see Muse's visits "as your activity," so a shop could still retarget you.
- **Meta's access.** Policy "restricts access to your data by Meta personnel" but "does not prevent Meta from accessing data when necessary to support, secure or operate the service." A Confidential VM that even Meta can't open was promised for "later this year"; on October 25, the privacy policy still said "in the future."
- **Retention.** Muse's pages give no retention period, and Meta "may access and retain logs of actions taken by Muse" ([terms](https://muse.ai/terms)). The privacy policy lists no regional differences.

The terms put the risk on you: you "will maintain meaningful human oversight over all actions taken."

![Meta's FAQ entry Is Muse safe?, answering Yes and citing automated protections, security standards, user controls and activity review](/blog/images/meta-muse-is-muse-safe-faq.png "Meta's own answer, on its Muse page. Screenshot: Muse product page, Meta.")

## Muse incidents and criticism, with dates

- **September 20.** Amazon began blocking Muse, saying shopping agents "should operate openly and respect service provider decisions about whether or not to participate" ([The Star, via Bloomberg](https://www.thestar.com.my/tech/tech-news/2026/09/22/amazon-blocks-metas-muse-ai-agent-from-its-retail-site)). It objected that Muse doesn't identify itself as an agent ([SiliconANGLE](https://siliconangle.com/2026/09/21/amazon-blocks-metas-muse-agent-from-shopping-on-users-behalf/)).
- **September 21.** Patrick Wardle disclosed a Mac app zero-day: any local app could redirect Muse's transcription endpoint and capture the account's token ([Ars Technica](https://arstechnica.com/security/2026/09/muse-metas-extraordinarily-privileged-ai-assistant-has-a-serious-0-day/)). Meta said it shipped a hotfix, and called the flaw "not a remote exploit."
- **September 22.** A developer asked Muse to archive its files to Google Drive and got 6.8 GB, including SSH key files he couldn't confirm were active. Meta's bug bounty marked the report "Not Applicable" ([Mouse](https://mouse.dev/blog/muse-runtime-export/)).
- **September 28.** A YouTuber's Muse sent his address to Marketplace buyers. He'd chosen "Allow Always," "thinking it would still send approvals to accept offers later down the line (it didn't so be careful)" ([his update, via Mike Masnick](https://bsky.app/profile/masnick.com/post/3mwn2mtude22e)).
- **September 30.** Meta disputed columnist Jason Aten's report that Muse read his Messages unasked: "You have to enable both Full Disk Access and the Messages connector" ([TechCrunch](https://techcrunch.com/2026/09/30/meta-disputes-claim-that-muse-read-a-users-private-messages-without-permission/)). On October 2, Apple tightened Full Disk Access, warning that as AI agents grow more capable, "the risks associated with this level of access will grow substantially." It named no app ([Apple](https://developer.apple.com/news/?id=p6zjojqw)).
- **October 5.** 404 Media reported a pre-launch "mad dash" to fix "a sudden spike in reported KVM escapes" ([404 Media](https://www.404media.co/meta-rushed-to-fix-muse-vm-escape-vulnerability-immediately-before-launch/)). Meta cited "agentic red teaming and our bug bounty program."
- **October 6.** Techdirt called Muse "an adorable privacy and security dumpster fire" ([Techdirt](https://www.techdirt.com/2026/10/06/metas-muse-is-an-adorable-privacy-and-security-dumpster-fire/)), drawing 392 points and 290 comments on [Hacker News](https://news.ycombinator.com/item?id=49977588).

On October 9, Sierra published a draft Personal Agent Protocol, built with Meta, for agents to identify themselves to businesses ([Sierra](https://sierra.ai/blog/poppy)). We found no regulator action aimed at Muse by October 25.

### What Meta says, and what independent experts say

Meta's FAQ answers "Is Muse safe?" with "Yes." Its engineers hedge: "Prompt injection remains an open problem in the industry — and Muse will sometimes make mistakes."

Wardle told 404 Media that "having access to production environment literally one KVM escape away, is plain irresponsible." Miranda Bogen of the Center for Democracy and Technology told Wired that agents solicit "dramatically more information than people might have otherwise given." The most-answered Hacker News comment: "I just do not trust any of them, not with my money or with access to my conversations" ([HN](https://news.ycombinator.com/item?id=49978280)). A defender countered that "any content on the VM is yours" ([HN](https://news.ycombinator.com/item?id=49979930)).

## What self-hosting changes

- **Who stores it.** OpenTeam keeps conversations, files, memory, routines, website sign-ins and plugin tokens on your server ([privacy](/docs/configuration/privacy)). No AI company holds a copy, and on hardware you own, the disk is yours too.
- **Who trains on it.** OpenTeam has no model to train, and its makers never receive your chats. You choose the model provider: use [a local model](/blog/ai-agents-local-models) to keep prompts at home, or a [zero-data-retention route](https://openrouter.ai/docs/guides/features/zdr) for hosted ones.
- **Who can read the code.** It's GPL-3.0, so you can check where every request goes ([GitHub](https://github.com/raghavpillai/openteam)). Muse's agent is closed.

![Muse stores chats, files and sign-ins in Meta's cloud with training on by default; OpenTeam stores them on your server, and prompts go to the hosted or local model you pick](/blog/images/meta-muse-vs-openteam-data.png "Self-hosting moves storage to your machine, and you pick where prompts go. Diagram: OpenTeam.")

## How OpenTeam keeps you in the loop

OpenTeam puts you in charge of the steps that matter most:

- **Email waits for Send, enforced in code.** Bots draft emails as cards. The send tool is hidden from bots and runs on the server only after you press Send ([code](https://github.com/raghavpillai/openteam/blob/main/apps/server/src/services/plugin/transport.ts), [email](/docs/integrations/email)). You can let chosen recipients skip the card or turn drafts off for a bot. Slack replies get a draft card too, and texts through Messages on your Mac wait on a card unless you've allowed that person.
- **Secure forms.** You type a password or card into a form in the chat, OpenTeam fills the page, and the values never come back to the model.
- **A handoff card** when a step needs you, such as a passkey, a 3-D Secure check or a CAPTCHA ([computer](/docs/usage/computer)).
- **Prompt rules for the rest.** Bots are told to show you messages to other people before sending, and the built-in purchases skill says "nothing is created or charged unless they approve that exact purchase." Tool results are fenced as untrusted data the model is told not to act on.

![An OpenTeam Gmail reply card from a Chief of Staff bot, with From, To, Subject and body fields and Send and Discard buttons](/blog/images/openteam-email-draft-approval.png "A reply waits for Send. Bots have no email send tool. Sample data. Image: OpenTeam.")

## How to use any personal AI agent safely

1. **Give it separate accounts.** For Muse, sign up with an email not tied to your other Meta accounts ([terms](https://muse.ai/terms)). For a self-hosted team, give bots narrow accounts of their own rather than yours.
2. **Pay with a limited card:** virtual, single-use or low-limit, never your main debit card.
3. **Connect only what the task needs,** read-only first. "Start small," a security executive told [Time](https://time.com/article/2026/10/22/ai-meta-muse-agent-older-users/).
4. **Keep send, pay and delete behind approval.** Avoid "Always allow" until you've watched it finish a task.
5. **Watch its screen and read its activity** for the first few weeks.
6. **Turn off training** you don't want, in the agent and at your model provider.
7. **Be stingy with system permissions** like Full Disk Access, and give password managers a vault with only the logins needed ([accounts](/docs/integrations/accounts)).
8. **Treat what it reads as untrusted.** Don't let it act on strangers' email or pages unchecked.
9. **Revoke access you don't use.** Disconnecting stops new reads, not old ones: that data "may remain in Muse's memories," Meta says.
10. **Keep it patched.** For a self-hosted agent such as OpenTeam, run it on its own machine or VM, keep the host, Docker and OpenTeam updated ([updates](/docs/manage/updates)), keep [backups](/docs/manage/backups), and reach it over your network or [Tailscale](/blog/tailscale-https-self-hosted-ai-agents) rather than a public port.

## Frequently asked questions

### Is Meta Muse safe?

Safe enough to try with care, not to connect to everything. Muse has strong guardrails: Sentinel, a credential store and per-purchase approvals. Its first weeks also brought a patched Mac zero-day and permission mix-ups, and Meta trains on your chats unless you opt out.

### Does Meta train on Muse conversations?

Yes, by default. Turn off **Help improve our AI models** under **Settings → Data controls**; Meta says the change applies to past interactions too ([Meta](https://www.meta.com/help/superintelligence/2225571704857152/)).

### Is Meta Muse open source?

No. The Muse agent and apps are proprietary. Meta publishes some open-weight models, such as Muse Glimmer under Apache-2.0 ([Meta](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)), but not the agent. OpenTeam is an open-source alternative under GPL-3.0.

### Can I self-host Meta Muse?

No. Muse runs only in Meta's cloud, and the promised Confidential VM would still run on Meta's servers. To self-host, you need a different agent, such as OpenTeam.

### Where does a self-hosted agent like OpenTeam keep my data?

On your server. OpenTeam stores conversations, files, memory, routines, website sign-ins and plugin tokens there ([privacy](/docs/configuration/privacy)), has no model to train, and sends prompts to the model provider you choose, or to a local model on your own hardware. The code is GPL-3.0, so you can check where every request goes.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, or `irm https://openteam.so/install.ps1 | iex` in Windows PowerShell. The [quickstart](/docs/getting-started/quickstart) covers your first bot, and the apps are on the [download page](/download).
