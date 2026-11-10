---
title: "Text your AI agent: OpenAI dots vs a bot on your own iMessage"
seoTitle: "ChatGPT dot texting vs a self-hosted AI agent on iMessage"
description: ChatGPT Pro users in the US can now text their dot. How that compares with OpenTeam, whose self-hosted bots send texts from Messages on your own Mac.
date: 2026-10-29
category: Comparisons
image: /blog/images/text-ai-agent-message-paths.png
imageAlt: A diagram of two message paths. A text to an OpenAI dot goes from your phone through Linq to OpenAI's cloud. An OpenTeam bot on your server sends texts through the desktop app and Messages on your Mac to the other person
related: ai-imessage-assistant, grok-bot-vs-meta-muse-vs-openai-dots, tailscale-https-self-hosted-ai-agents
---

**Since October 28, ChatGPT Pro users in the US can text their OpenAI dot over iMessage or RCS, and the dot texts them first when something comes up. OpenTeam, an open-source, self-hosted AI agent team, works the other way round. Its bots read and send texts through Messages on your own Mac, and you talk to them in the OpenTeam app. You can't text an OpenTeam bot.**

We build OpenTeam (GPL-3.0), so weigh our view accordingly. The dots facts below come from OpenAI's release notes, help center, docs and posts, checked for this post. We didn't try dot texting: it needs a US ChatGPT Pro account. OpenTeam's side comes from the desktop app's source and our [computer docs](/docs/usage/computer#messages-on-a-mac), and its screenshots are staged with sample data.

![Two message paths: a text to a dot goes from your phone through Linq to OpenAI's cloud; an OpenTeam bot on your server sends through the desktop app and Messages on your Mac to the other person](/blog/images/text-ai-agent-message-paths.png "Texting a dot means texting OpenAI's agent. OpenTeam bots text other people from your Mac, and you reach them in the app. Diagram: OpenTeam.")

## Dot texting vs OpenTeam at a glance

Dots facts from OpenAI's pages linked below, as of October 29, 2026. OpenTeam facts from its code and docs. "Not stated" means OpenAI's pages don't say.

| | OpenAI dot texting | OpenTeam with Messages |
|---|---|---|
| What it is | You text your dot, an agent in OpenAI's cloud | Bots on your server read and send texts through your Mac |
| Who can use it | ChatGPT Pro users in the US, as a preview | Anyone who runs the server, with a Mac signed in to Messages |
| Can you text the agent? | Yes, from the phone number you verify | No; you message bots in the OpenTeam app |
| Who it texts | Only you | Anyone, from your own number |
| Texts you first | Yes, with updates it thinks you need | No; bots message you in the app |
| Channels | iMessage or RCS; no SMS or group chats | iMessage and SMS through the Messages app, groups included |
| Before it sends | Your dot texts only you | A **Send this message?** card, unless you allowed that person |
| In between | Linq, a third-party relay; not end-to-end encrypted | Your server, your Mac and your model provider |
| Setup | A profile setting and a code | A server, the desktop app on a Mac, three macOS permissions |
| Price | Included in ChatGPT Pro, from $100 a month | Free; you pay for the machine and the model |
| Open source | No | Yes, GPL-3.0 |

## How texting your dot works

OpenAI launched dots on September 29, "always-on agents" in ChatGPT with their own cloud computers ([OpenAI](https://openai.com/index/introducing-dots/)). On October 28 it added texting: "Texting your dot is starting to roll out in beta to Pro users in the U.S." ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)). Dots are for users 18 and older, and Pro plans cost $100, $200 or $500 a month ([pricing](https://learn.chatgpt.com/docs/pricing)).

**Setup.** You open your dot's profile, choose Texting, enter your phone number and type the code it sends ([help center](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)). The dot sends a contact card to save. On an iPhone you text from the number you verified; on Android you turn on RCS ([OpenAI](https://learn.chatgpt.com/docs/dots/channels)).

**What it keeps.** "Texting your dot shares the same memory and plugins as your dot in the ChatGPT app, so context carries over," OpenAI says. You can send text, photos and voice notes, and give it "a task to take off your plate or something to keep an eye on" ([ChatGPT on X](https://x.com/ChatGPT/status/2115496387613786374)). When the dot needs your approval, it sends a link that opens the request in ChatGPT.

**It texts you first.** "Your dot will also text you proactively with updates that may be relevant for you." It picks where to reach you from your conversations, and you can tell it to text only for urgent things.

**Only you.** "Your dot can only text you, and you're the only one who can text your dot." Group chats, phone calls and FaceTime aren't supported over text. Texting also "doesn't give your dot or OpenAI access to your other text conversations" ([ChatGPT on X](https://x.com/ChatGPT/status/2115497827845476525)).

**The relay.** OpenAI uses Linq, a third-party messaging provider, to send and receive the dot's texts. Because Linq processes them on the way, "the conversation is not end-to-end encrypted between you and your dot, even when you use iMessage or RCS" ([help center](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)). OpenAI stores the texts with your dot's ChatGPT conversations. SMS isn't supported, carrier rates may apply, and replying STOP ends it.

OpenAI publishes no limits on message length or response time for texting.

## How OpenTeam bots use Messages

OpenTeam bots live on your server, each with its own Linux computer. Messages lives on a Mac. The desktop app joins the two: it connects that Mac to your server with an outgoing connection, then reads the Mac's Messages database and sends by scripting the Messages app. Apple has no API for this, which is why it needs a Mac at all.

### Turning it on

Messages is off until you turn it on in the app on that Mac, under **Settings → Computer**. Until then, bots don't get Messages tools for it, and the server can't switch it on remotely.

1. Turn on **Use Messages**.
2. A window lists three macOS permissions: **Automation** to send through Messages, **Contacts** to find people by name, and **Full Disk Access** to search your texts. Choose **Allow** next to each. macOS doesn't prompt for Full Disk Access, so that button opens System Settings.
3. Ask a bot what's new in your texts.

![The OpenTeam permissions window titled Allow OpenTeam to Use Messages, with Automation and Contacts done and an Allow button next to Full Disk Access](/blog/images/openteam-messages-permissions-dialog.png "The three macOS permissions Messages needs. Full Disk Access is the one you turn on in System Settings. Sample data. Image: OpenTeam.")

For SMS from a Mac, turn on Text Message Forwarding for that Mac on your iPhone. The app has to stay open: a Mac that sleeps or quits the app goes offline.

### Every text waits on a card

When a bot wants to send a text, a **Send this message?** card appears in its chat, on the desktop and iPhone apps. It shows the recipient, the exact text and the Mac it will go out from.

![An OpenTeam chat where the Chief of Staff bot relays that Dana's plumber can come Tuesday from 9 to 11, then shows a Send this message? card to Dana Ortiz with Send, Always allow Dana Ortiz and Discard buttons](/blog/images/openteam-messages-send-card.png "The bot drafted the reply; nothing goes out until you press Send. Sample data. Image: OpenTeam.")

- **Send** sends it once, from that Mac. If the Mac is offline, the card stays open with the reason, and pressing Send again never texts twice.
- **Discard** drops it, and the bot is told not to send it another way.
- **Always allow** sends it and lets bots text that person from that Mac without a card from then on. It appears only for a text to one person, not a group.

In OpenTeam's code, a bot's send tool always creates the card, and the server delivers the text only after you press Send or when one of your rules allows it. The card guards that tool, not the whole Mac: bots can also run terminal commands on a connected computer without asking ([computer docs](/docs/usage/computer#use-your-own-computer)). Connect only a Mac you trust your bots with.

### Rules per Mac

**Send Without Asking** skips the card for every text, and **Allowed recipients** lists the people you've allowed, with a button to remove each. Both belong to one Mac, and turning Messages off and on again clears them.

![OpenTeam Settings, Computer page: Use Messages on, macOS permissions allowed, Send Without Asking off, and an Allowed recipients list with Maya Chen and Sam Rivera](/blog/images/openteam-messages-settings-allowed-recipients.png "Messages settings belong to the Mac you're using. Sample data. Image: OpenTeam.")

With Messages on for more than one Mac, a bot uses the Mac you last wrote to it from, or the only one online. Close a MacBook and a Mac mini that's awake takes over. **Settings → Server → Manage devices** shows which Macs are online and which have Messages on.

## Can you text an OpenTeam bot?

No. Nothing in OpenTeam watches for new texts. A bot sees your Messages only when it reads them during a chat turn, for example when you ask "what did I miss?" in the app. Routines and helper agents don't get Messages tools at all, so a bot can't answer texts on a schedule either.

That's the core of what dots added, and OpenTeam doesn't have it. To reach your bots from your phone, you use the OpenTeam iPhone app, a TestFlight beta, over your home network or a VPN such as [Tailscale](/blog/tailscale-https-self-hosted-ai-agents). Bots can message you in the app at any time, for example from a [routine](/docs/usage/routines). iPhone alerts, though, are push notifications that need Apple push credentials on your server from the team that signs the iPhone app ([mobile notifications](/docs/configuration/mobile-notifications)). The desktop apps show banners without them.

So the two products answer different questions. A dot is an assistant you text. OpenTeam's Messages support lets your own agents work inside your existing conversations, with each outgoing text under your eye. [Our guide to replying to iMessages with a self-hosted AI agent](/blog/ai-imessage-assistant) covers that side in depth.

## What dots does better

- **Setup.** One setting and a code. OpenTeam needs a server running Docker, a model, the desktop app on a Mac that stays awake and three macOS permissions.
- **Any phone.** It works from the Messages app on an iPhone or an Android phone with RCS. OpenTeam's desktop apps are for macOS on Apple silicon and Linux x64, its iPhone app is a TestFlight beta, and there's no Android app.
- **It reaches you.** A dot can text you first, wherever you are. An OpenTeam bot's message waits in the app unless push is set up.
- **Photos and voice notes.** You can text a dot a photo or a voice note. OpenTeam bots send text only through Messages, with no attachments or reactions.
- **One account for everything.** The dot keeps your ChatGPT memory and plugins, and it can work in Slack and Teams too ([OpenAI](https://learn.chatgpt.com/docs/dots/channels)).

If you want an assistant you can text from any phone and you already pay for Pro, a dot is the better tool today.

## Where OpenTeam fits

OpenTeam fits a different job: bots that work inside your real conversations, on hardware you control. They read your history on the Mac, find people in Contacts, open photos people sent and reply in existing chats or start new ones, from your own number. Several bots share the same Macs, and you choose the model, including a local one.

The trade-offs are real. Texts a bot reads go to your model provider ([privacy](/docs/configuration/privacy)). Incoming texts can carry instructions aimed at the bot, so read each card before you press Send. OpenTeam also has its usual limits: one model serves every bot on a server, there's one human account per server, and the only approval cards are for outgoing email, Slack messages and texts.

## Which should you use?

- **Choose a dot if** you're a US ChatGPT Pro user and want an assistant you can text, that texts you first, from any phone.
- **Choose OpenTeam if** you want agents that read and answer your own Messages from your Mac, with a card before each text, open source and on your own server.
- **Use neither for auto-replies.** Neither one answers incoming texts from other people on its own.

## Frequently asked questions

### Can I text ChatGPT?

Yes, if you're a ChatGPT Pro user in the US. Since October 28, 2026, you can text your dot over iMessage or RCS after verifying your number in its profile ([OpenAI](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)). Plain SMS isn't supported.

### Is texting a ChatGPT dot end-to-end encrypted?

No. OpenAI's help center says Linq processes the texts on the way to OpenAI, so the conversation "is not end-to-end encrypted," even over iMessage or RCS ([OpenAI](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)).

### Can a dot text other people for me?

No. A dot texts only you, and only you can text it. OpenTeam bots can text other people from your Mac, and each text waits for you to press Send unless you've allowed that person.

### Can I text my OpenTeam bot from my phone?

No. OpenTeam has no trigger on new texts, so bots read Messages only when you ask in the app. From your phone, use the iPhone app over your network or a VPN.

### Can an AI agent reply to my iMessages automatically?

Not with either of these. A dot can't reply to other people, and OpenTeam bots send only when you ask in chat, with a card unless you allowed the recipient. Routines can't use Messages.

### Does dot texting work outside the US?

Not as of October 29, 2026. Texting is a preview for ChatGPT Pro users in the US. OpenTeam runs anywhere you can run Docker, but Messages needs a Mac.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, then follow the [quickstart](/docs/getting-started/quickstart). Get the Mac app from the [download page](/download) and turn on **Use Messages** in its settings.
