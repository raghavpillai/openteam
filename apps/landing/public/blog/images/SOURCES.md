# Blog images

Images used in blog posts. Rasters wider than 1600 px were scaled down to 1600 px, and some were converted between PNG, JPEG and WebP; none were cropped or edited. Third-party images were retrieved on 2026-10-12 and 2026-10-13. Each post captions them with their owner.

## OpenTeam

- `openteam-desktop.png`: the macOS desktop app with a bot's chat, a live preview of its screen and a routine. Scaled from `docs/images/openteam-desktop.png`.
- `openteam-desktop-mobile.png`: the desktop and iPhone apps showing the same conversation. Copied from `docs/images/openteam-desktop-mobile.png`.

Staged screenshots for the call4me guide render the shipping desktop components in a local browser fixture with synthetic data (fictional businesses, people, 555 phone numbers and a dummy token), captured at 2× on 2026-10-15 and scaled to 1600 px wide:

- `openteam-add-custom-mcp-call4me.png`: the Add custom MCP form filled in for call4me.
- `openteam-call4me-bearer-token.png`, `openteam-call4me-connection.png`, `openteam-call4me-activity.png`: the call4me plugin dialog with the Bearer token field, the connected account and tool list, and the Activity log.
- `openteam-call4me-call-chat.png`: a bot chat calling a fictional internet provider.
- `openteam-call4me-routine.png`: a routine that calls a fictional pharmacy weekly.

Staged screenshots for the Tailscale HTTPS guide use the same method with a made-up machine and tailnet (`office-server.tail1a2b3c.ts.net`), captured on 2026-10-15:

- `openteam-remote-access-tailscale.png`, `openteam-remote-access-tailscale-panel.png`: Settings → Server → Remote access with Tailscale HTTPS configured.
- `openteam-remote-access-tailscale-enable.png`: the same section before enabling.
- `openteam-remote-access-remote-commands.png`: the section for a remote server, listing the commands to run on the host.
- `openteam-login-tailscale-url.png`: the desktop sign-in screen with the tailnet HTTPS address.

Staged screenshots for the Google Docs, Sheets and Slides guide use the same method with a fictional coffee roaster and made-up documents, captured on 2026-10-18:

- `openteam-google-plugins.png`: the plugin manager with the Google Docs, Sheets, Slides, Drive, Gmail and Calendar plugins connected.
- `openteam-sheets-routine-chat.png`: a bot's weekly update to a Google Sheet beside its Monday routine.
- `openteam-deck-two-designs.png`: a bot offering two title-slide designs before building a deck.

Staged screenshots for the iMessage guide use the same method, with fictional people, businesses and conversations, captured on 2026-10-19:

- `openteam-imessage-catch-up-chat.png`: a bot summarizing texts since the morning, then replying in an existing conversation.
- `openteam-imessage-ssh-account.png`, `openteam-imessage-ssh-tools.png`: the iMessage (SSH) plugin's account settings with a Mac SSH address, and its tool list with sending turned on.
- `openteam-imessage-business-reply.png`: a text reply in a fictional airline's Messages for Business chat.
- `openteam-imessage-unanswered-routine.png`: a weekday routine that summarizes unanswered texts and suggests replies.

Staged screenshots for the Claude Duet comparison use the same method, with fictional people, businesses, invoices and `example.com` addresses, captured on 2026-10-21:

- `openteam-morning-brief-routine.png`: a bot creating a weekday 7:30 AM morning-brief routine from a chat request, with the routine panel open.
- `openteam-morning-brief-chat.png`: the routine's morning brief of meetings, emails, an invoice and a Slack request that need attention.
- `openteam-email-draft-approval.png`: an email reply draft card waiting for Send, with the Needs approval setting.

Diagrams and charts for the engineering posts were drawn for this blog in HTML and SVG on a 1,000 px canvas, rendered at 2× and scaled to 1600 px wide. Numbers come from the source code. Each post's version frames share one template, so each component stays in the same place as the design grows:

- `memory-design-overview.png`: the memory design's steps, and the first step compared with the final design.
- `memory-design-v0.png` to `memory-design-v5.png`: the memory design at each step.
- `memory-design-paths.png`, `memory-design-scopes.png`: the final write and read paths, and the four memory scopes.
- `agent-messaging-overview.png`: the messaging design's steps, and the first step compared with the final design.
- `agent-messaging-v0.png` to `agent-messaging-v5.png`: bot-to-bot messaging at each step.
- `agent-messaging-room.png`, `agent-messaging-delivery.png`, `agent-messaging-priorities.png`, `agent-messaging-patterns.png`: a group chat round, the delivery path, mailbox priorities and the three communication patterns.
- `bot-computer-overview.png`: the bot computer design's steps, and the first step compared with the final design.
- `bot-computer-v0.png` to `bot-computer-v7.png`: a bot's computer at each step.
- `bot-computer-anatomy.png`: the final computer container, the server's VNC proxy and the apps.

Diagrams for the Claude Duet comparison use the same method. Claude Duet facts come from Anthropic's announcement and help center on 2026-10-21; OpenTeam facts come from its docs and code:

- `claude-duet-scorecard.png`: where Claude Duet and OpenTeam differ.
- `claude-duet-where-it-runs.png`: where each agent runs and holds your data.
- `claude-duet-morning-brief.png`: an OpenTeam morning-brief routine from schedule to sent reply.
- `claude-duet-urgent-email.png`: Duet's interval checks next to an OpenTeam email-triggered routine.

## Third-party images

**Repo license**: committed in the project's own repository under that license. **Vendor screenshot**: published by the vendor on its own site, with no stated license; used for commentary and credited in the caption.

| File | Shows | Source | Owner | Basis |
|---|---|---|---|---|
| `call4me-ai-call-assistant.png` | call4me's share card for its AI call assistant | [call4.me/ai-call-assistant](https://call4.me/ai-call-assistant) (`/og/assistant.png`) | call4me | Vendor image |
| `claude-cowork-web-and-mobile-approvals.png` | Cowork tasks on iPhone and web, with an approval prompt | [claude.com article, 2026-07-07](https://claude.com/resources/articles/cowork-web-mobile) | Anthropic | Vendor screenshot |
| `claude-cowork-built-in-browser.jpg` | Cowork's built-in browser beside the chat | [claude.com/product/cowork](https://claude.com/product/cowork) | Anthropic | Vendor screenshot |
| `claude-duet-app-screens.png` | Duet's morning brief, email approval and payment approval, three product-page phone mockups placed side by side without edits | [claude.com/product/claude-duet](https://claude.com/product/claude-duet), retrieved 2026-10-21 | Anthropic | Vendor screenshot |
| `grok-bot-multi-bot-handoff.jpg` | An orchestrator bot messaging other bots and creating a routine | [x.ai Grok Bot guide](https://x.ai/bot/guides/grok-bot-for-mobile-app-development) | SpaceXAI LLC (xAI) | Vendor screenshot |
| `grok-bot-approval-prompt.jpg` | A support bot asking to approve its write actions | [x.ai Grok Bot guide](https://x.ai/bot/guides/grok-bot-for-support) | SpaceXAI LLC (xAI) | Vendor screenshot |
| `meta-muse-browser-task.png` | Muse booking cinema seats in its own browser | [muse.ai](https://muse.ai/) (`/images/landing/browser.webp`) | Meta | Vendor screenshot |
| `openai-dots-chat-and-cloud-computer.png` | A dot fixing a bug in chat beside its cloud browser | [OpenAI dots launch post, 2026-09-29](https://openai.com/index/introducing-dots/) | OpenAI | Vendor screenshot |
| `meta-muse-approval-prompt.png` | Muse asking before it places an order | [muse.ai](https://muse.ai/) (`/images/landing/approvals.webp`) | Meta | Vendor screenshot |
| `openclaw-control-ui-chat.png` | OpenClaw's Control UI chat with Skill Workshop | [OpenClaw blog, 2026-06-03](https://openclaw.ai/blog/openclaw-agent-skill-workshop) | OpenClaw | Vendor screenshot |
| `openclaw-whatsapp-chat.jpg` | Chatting with OpenClaw in WhatsApp | [openclaw/openclaw `docs/whatsapp-openclaw.jpg`](https://github.com/openclaw/openclaw/blob/main/docs/whatsapp-openclaw.jpg) | OpenClaw contributors | MIT |
| `hermes-agent-desktop-app.jpg` | The Hermes Agent desktop app | [nousresearch.com](https://nousresearch.com/) | Nous Research | Vendor screenshot |
| `goose-desktop-chat.png` | The goose desktop app calling an MCP extension (February 2026) | [goose blog, 2026-02-25](https://goose-docs.ai/blog/2026/02/25/order-lunch-with-goose) | goose contributors | Apache-2.0 |
| `nanoclaw-installer-welcome.jpg` | NanoClaw's terminal installer | [nanoclaw.dev blog](https://nanoclaw.dev/blog/deploy-nanoclaw-on-exe-dev) | NanoClaw | Vendor screenshot |
| `agent-zero-desktop-blender.jpg` | Agent Zero driving Blender on its XFCE desktop (first frame of the README GIF) | [agent0ai/agent-zero README](https://github.com/agent0ai/agent-zero) | Agent Zero, s.r.o. and contributors | MIT |
| `eigent-workforce-task.png` | Eigent's Workforce view mid-task | [eigent.ai use case](https://www.eigent.ai/use-cases/kimi-k2-sales-performance-excel-html-report) | Eigent.AI | Vendor screenshot |
| `mausbot-chat-roster.png` | MausBot's chat app with a roster of bots | [milind-soni/OpenMausBot README](https://github.com/milind-soni/OpenMausBot) | Milind Soni and contributors | Apache-2.0 |
| `mausbot-computer-panel.png` | MausBot's Computer panel with a live screen preview | [milind-soni/OpenMausBot README](https://github.com/milind-soni/OpenMausBot) | Milind Soni and contributors | Apache-2.0 |
