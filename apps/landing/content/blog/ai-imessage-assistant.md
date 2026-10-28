---
title: Reply to iMessages with a self-hosted AI agent
seoTitle: "AI iMessage assistant: reply to texts with self-hosted agents"
description: An AI iMessage assistant you host yourself. Turn on Messages in OpenTeam's Mac app, approve each text from a card, and use more than one Mac.
date: 2026-10-19
updated: 2026-10-28
category: Guides
image: /blog/images/openteam-imessage-catch-up-chat.png
imageAlt: An OpenTeam chat where the Chief of Staff bot summarizes four Messages conversations from the morning, then replies to Maya in her existing conversation that Saturday at 7 at Lucia's works
related: ai-agent-phone-calls, tailscale-https-self-hosted-ai-agents, openclaw-alternative
---

**Yes, an AI agent can read your Messages and reply in your own iMessage and SMS conversations. OpenTeam is an open-source, self-hosted AI agent team. Its bots reach Messages through the desktop app on a Mac where you turn Messages on. Each text waits on an approval card until you press Send, unless you allow that person, or every text, on that Mac.**

We build OpenTeam (GPL-3.0), so weigh our view accordingly. This guide is based on the desktop app's source and our [computer docs](/docs/usage/computer#messages-on-a-mac). Facts about other products link to their own pages, checked October 19, 2026. Screenshots are staged with sample data.

## Two kinds of AI iMessage assistant

Search results for an AI iMessage assistant mix two things:

- **An AI you text.** The assistant is a contact with its own number. You text [Poke](https://poke.com) on Messages, WhatsApp or Telegram, and it handles email, calendar and reminders. It doesn't document reading your own message history.
- **An AI inside your own conversations.** It reads the Messages history on a Mac and sends from your account. ChatGPT's Messages plugin, Claude's "Read and Send iMessages" connector and OpenTeam work this way.

The second kind, covered here, is more useful and riskier: it sees everything you've received, and recipients see your name on what it writes.

## What OpenTeam bots can do in Messages

Apple has no Messages API for this, so the desktop app reads the Mac's Messages database and sends by scripting the Messages app.

- **Read history:** iMessage, SMS and RCS conversations, search, and what's new across chats.
- **Open attachments:** up to 100 MiB; HEIC photos come back as JPEG.
- **Find people:** by name in Contacts, with Contacts permission.
- **Send texts:** to an existing chat, a group, or a new number or email, after you approve the card.

## What you need

- An up-to-date OpenTeam server, with a [model](/docs/configuration/models) that handles tool calls well.
- A Mac signed in to Messages, with the OpenTeam app for Apple silicon from the [download page](/download). For SMS, turn on Text Message Forwarding for that Mac on your iPhone, under **Settings → Apps → Messages**.

## Set it up

The desktop app connects your Mac to your server with an outgoing connection, so you don't open any ports. Bots use native tools on the Mac; they don't see your screen.

1. **Sign in.** Install the app on that Mac and sign in. The Mac joins automatically and shows as **Online now** under **Settings → Computer → Manage devices**.
2. **Turn on Messages.** In **Settings → Computer**, turn on **Use Messages**. Until you do, bots don't get Messages tools for that Mac at all.
3. **Grant access.** A window lists three macOS permissions; choose **Allow** next to each. **Automation** lets bots send through Messages and **Contacts** lets them find people by name; accept the macOS prompt for each. **Full Disk Access** lets bots search your texts; macOS doesn't ask for this one, so **Allow** opens System Settings, where you turn on OpenTeam.
4. **Check it.** Ask a bot what's new in your texts.

Keep the app open while bots use Messages. If it closes or the Mac sleeps, that Mac goes offline.

### More than one Mac

Turn on Messages on each Mac you want bots to use. A bot uses the Mac you last wrote to it from. If that Mac is offline, for example a MacBook with its lid closed, it uses another Mac that's online with Messages on, such as a Mac mini at home. When more than one Mac could serve and you wrote from your phone, the bot asks which one, or names one itself. **Settings → Computer → Manage devices**, on the desktop or the iPhone app, shows which Macs are online and which have Messages on.

## Approve texts before they go out

A text a bot wants to send appears as a **Send this message?** card in its chat, on the desktop and iPhone apps. It shows who it's to, the exact text and which Mac sends it.

- **Send** sends it once from that Mac. The bot is told whether it went out.
- **Discard** drops it, and the bot is told not to send it another way.
- **Always allow** sends it and lets bots text that person from that Mac without a card from then on.

Under **Settings → Computer → Messages**, **Send Without Asking** skips the card for every text, and **Allowed recipients** lists the people you've allowed, with a button to remove each. Rules belong to one Mac. Turning Messages off and on again on that Mac clears them.

## Example prompts for your Messages

### Catch up on what you missed

> What did I miss in Messages since this morning? Group it by person and tell me which ones need a reply.

The bot lists the chats active since then, reads them and summarizes.

![An OpenTeam chat where the Chief of Staff bot lists four conversations since 8 AM, then replies to Maya that Saturday at 7 at Lucia's works](/blog/images/openteam-imessage-catch-up-chat.png "A catch-up, then one reply to Maya. She's an allowed recipient on this Mac, so the reply skips the approval card. Sample data. Image: OpenTeam.")

### Find what someone said about a topic

> What did Maya say about the lake house dates?

The bot finds Maya in Contacts, opens her conversations and searches them. Search matches message text, not names.

### Open a photo someone sent

> Show me the photo Dana sent yesterday of the leak under the sink.

The bot fetches the attachment and looks at it. A photo kept only in iCloud can't be fetched.

### Reply in an existing chat

> Tell Maya Saturday works, 7 at Lucia's.

The bot finds the chat and raises an approval card with the exact text. Press **Send** and it goes out from your Mac; the bot is told the outcome. It words the reply itself, so quote the text when wording matters, or fix it by asking for a new card.

## How it compares to ChatGPT, Claude and others

From each product's docs or listing, checked October 19, 2026. We haven't tested the others. "Not stated" means the vendor's page doesn't say.

| Option | How it connects | Reads your history | Replies in your chats | Send control | Open source |
|---|---|---|---|---|---|
| OpenTeam desktop app | App on your Macs | Yes | Yes, and starts new chats | Approve each send, or always allow a recipient or every send on that Mac | Yes, GPL-3.0 |
| [ChatGPT Messages plugin](https://learn.chatgpt.com/docs/plugins?surface=app#app-use-apple-messages-from-codex) | ChatGPT desktop app | Yes | Yes | Approve each send, or always allow a chat | No |
| [Claude Read and Send iMessages](https://claude.com/connectors/read-and-send-imessages) | Anthropic connector, macOS | Yes | Yes | Not stated | Not stated |
| [OpenClaw](https://docs.openclaw.ai/channels/imessage/deployment) (`imsg`) | `imsg` on a Mac, locally or over SSH | Its Apple ID's chats | To approved senders | [Pairing and allowlists](https://docs.openclaw.ai/channels/imessage/access-control) | Yes, MIT |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/bluebubbles) | BlueBubbles on a Mac, or a hosted [Photon](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/photon) line | BlueBubbles only | BlueBubbles, to approved senders | Pairing or allowlist | Yes, MIT |
| [Poke](https://poke.com) | You text Poke | Not documented | No; it's a contact | Not applicable | No |

OpenClaw's docs recommend a dedicated Apple ID for the bot. Apple's Smart Reply drafts a reply in the text field, and you press Return to send ([Apple](https://support.apple.com/guide/mac-help/mchl00c5b2c3/26/mac/26)). Beeper's Desktop API can search history and send or draft messages while Beeper Desktop runs, with iMessage on macOS only ([Beeper](https://developers.beeper.com/desktop-api)).

### What ChatGPT's plugin does better

- **No server.** It's a plugin in an app you may already use, on all ChatGPT plans.
- **Per-chat allow rules.** ChatGPT can always allow a whole chat, groups included. OpenTeam allows one recipient at a time; group texts always need a card unless you turn on Send Without Asking.

OpenTeam fits if you want open source, your own hardware and model, or more than one Mac.

## Safety: before an AI texts as you

**Incoming texts are untrusted.** Anyone can text you, and a text can carry instructions aimed at your bot: indirect prompt injection ([OWASP](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)). A Messages agent combines private data, untrusted content and a way to send, Simon Willison's "[lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)." The approval card is your check: read what a bot wants to send before you press Send, and be careful with Always allow and Send Without Asking.

**Your model provider sees what bots read.** iMessage is end-to-end encrypted, but a text a bot reads goes to your model provider ([privacy](/docs/configuration/privacy)). To keep it on your hardware, run your [own model server](/docs/configuration/models#use-your-own-model-server).

**Every bot can use it.** Connected computers are shared by all bots on the server. Only a bot's own chat turns get Messages tools; its helpers and routine runs don't.

**Only that Mac turns it on.** **Use Messages** is a setting in the app on the Mac itself. The server can't turn it on, and a Mac with it off refuses Messages requests.

**No double sends.** Each card sends at most once. The Mac keeps a receipt per card, so pressing Send again after a lost connection returns the first result instead of texting twice.

**Turning it off.** Turn off **Use Messages** on that Mac, or disable the Mac from its **…** menu under **Settings → Computer → Manage devices**.

## What it can't do yet

- **No trigger on new texts, and no routines.** Bots use Messages when you ask in chat; [routines](/docs/usage/routines) can't read or send texts.
- **Text only.** Bots don't send attachments, reactions or replies to a specific message.
- **A Mac must be awake** with the app open. A Mac that sleeps goes offline until it wakes.
- **OpenTeam limits.** One model and one human account per server. Desktop apps for macOS (Apple silicon) and Linux (x64) only, the iPhone app is a TestFlight beta, and there's no Android app.

## Troubleshooting

| Problem | What it means | What to do |
|---|---|---|
| The bot says it has no Messages tools | No online Mac has Messages turned on | Open the app on your Mac and turn on **Use Messages** in **Settings → Computer** |
| "Messages needs Full Disk Access" | The Mac can't read the Messages database | Turn on OpenTeam under **System Settings → Privacy & Security → Full Disk Access** |
| A send fails with a permission error | macOS hasn't allowed control of Messages | Choose **Allow** next to Automation; after a denial, turn on Messages under OpenTeam in **Privacy & Security → Automation** |
| "Mac is offline" on a card | The Mac slept or the app closed | Open the app on that Mac and press **Send** again |
| The bot asks which Mac to use | More than one Mac has Messages on | Name the Mac, or write from the Mac you want |

Ask a bot to check your Messages permissions; it names the missing grant without sending anything.

## Frequently asked questions

### Can AI reply to my iMessages for me?

Yes, on a Mac, when you ask it to. OpenTeam bots, ChatGPT's Messages plugin and Claude's connector can all send from your account. OpenTeam shows an approval card first unless you've allowed that recipient or every send on that Mac.

### Can ChatGPT read and send my iMessages?

Yes. Since August 2026, the Apple Messages plugin in ChatGPT's macOS desktop app reads iMessage, SMS and RCS chats and sends with your approval ([MacRumors](https://macrumors.com/2026/08/20/chatgpt-imessages-mac)). It works in Codex and ChatGPT Work on Apple silicon, not in regular chats.

### Is there an official iMessage API?

No. Apple's developer support says "macOS doesn't have an API for accessing the user's SMS messages," and scripting Messages is "quite limited" ([Apple Developer Forums](https://developer.apple.com/forums/thread/804040)). So Mac tools read the Messages database and script the Messages app.

### Does my Mac have to stay on?

One Mac with Messages on has to be awake with the app open. With Messages on for two Macs, bots use whichever is online, so a closed laptop falls back to a desktop Mac that stays on.

### Is it safe to let an AI read my texts?

Only with trade-offs. Your model provider sees the texts bots read, and incoming texts can carry instructions. Approving each text, a local model and explicit send requests narrow the risk.

### Can an AI auto-reply to every new text?

Not with OpenTeam: there's no new-message trigger, and routines can't use Messages. Shortcuts on macOS 26 can run an automation when a message arrives ([Apple](https://support.apple.com/en-us/125148)), but anything it sends goes out unreviewed.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, or `irm https://openteam.so/install.ps1 | iex` in Windows PowerShell, then follow the [quickstart](/docs/getting-started/quickstart). Get the Mac app from the [download page](/download).
