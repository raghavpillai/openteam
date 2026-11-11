# Blog images

Images used in blog posts. Rasters wider than 1600 px were scaled down to 1600 px, and some were converted between PNG, JPEG and WebP. Unless noted below, none were cropped or edited. Third-party images were retrieved on 2026-10-12 and 2026-10-13. Each post captions them with their owner.

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

Staged screenshots for the Claude Duet comparison use the same method, with fictional people, businesses, invoices and `example.com` addresses, captured on 2026-10-21:

- `openteam-morning-brief-routine.png`: a bot creating a weekday 7:30 AM morning-brief routine from a chat request, with the routine panel open.
- `openteam-morning-brief-chat.png`: the routine's morning brief of meetings, emails, an invoice and a Slack request that need attention.
- `openteam-email-draft-approval.png`: an email reply draft card waiting for Send, with the Needs approval setting.

Staged screenshots for the self-hosting guide use a made-up home server (`192.168.1.20`) and user (`sam`), captured on 2026-10-21. The desktop screens are the shipping first-run wizard (`apps/desktop/test/browser/model-onboarding.html`) walked in a local browser against a synthetic API fixture, with OpenRouter model IDs read from OpenRouter's public model list that day. The terminal screens are the shipping CLI renderers (`renderSetupSession`, `createSetupPresentation`, `renderCompactDoctor`) fed the same sample values and drawn in a terminal frame; the setup header, which shows the release version, is left out:

- `openteam-install-setup-connection.png`: the Connection step of `openteam setup`, with Private network and a detected private address.
- `openteam-install-setup-ready.png`: the end of setup, with the server address, username and app links.
- `openteam-install-server-check.png`: the desktop app's first-run server check.
- `openteam-install-model-test.png`: a passed model test with OpenRouter's Auto Router.
- `openteam-install-first-bot.png`: the Create your first bot screen.

Screenshots for the local-models guide are real captures, not staged. They come from the shipping desktop renderer, run in a local browser against a throwaway OpenTeam test server whose bots used Qwen 3.5 4B on Ollama, on 2026-10-21. The chat shows the model's actual replies:

- `openteam-local-models-settings.png`: Settings → Server → Model with Ollama as the provider and the `qwen3.5-agent:latest` model.
- `openteam-local-models-chat.png`: a bot's first turns on the local model, including its repeated greetings.

Screenshots for the iPhone Duo guide come from the shipping iPhone app, built in Debug from the commit of the TestFlight beta testers had on 2026-10-24 with Xcode 27.1, and run in Xcode's iPhone Duo simulator (iOS 27.1) against a local fixture server with fictional bots and conversations. The bot desktop in the computer view is the 2026-09-12 capture `/screenshots/linux-vendor-review.png`, streamed through a local VNC fixture. Captured on 2026-10-26 and framed in a plain device outline:

- `iphone-duo-openteam-unfolded.png`: the inner display, with the conversation list beside a Researcher chat.
- `iphone-duo-openteam-folded.png`: the outer display, with the conversation list and a group chat.
- `iphone-duo-openteam-computer.png`: a bot's computer on the inner display with the Take control menu open.

Screenshots for the tested roundup of open-source Grok Bot alternatives are real captures from our own test on 2026-10-26. Each project was installed on one Mac with its own install path, used with test accounts, bots named Scout and Ada and one OpenRouter model, and captured from the running app (headless Playwright or the app's debugging port). Each shows the project's own interface, credited to the project in the caption:

- `rakazo-bot-screen-panel.png`: Rakazo (Apache-2.0), `edge` images at commit `ccbfe31`, with Scout's chat beside its screen panel.
- `mausbot-bot-handoff.png`: MausBot (Apache-2.0 core), Mac app v0.1.127, with Scout handing work to Ada.
- `open-duet-team-panel.png`: Open Duet (Apache-2.0), 0.4.1 from source at commit `743d014`, with its My team panel open.
- `openteam-two-bot-handoff.png`: the OpenTeam desktop app on an isolated test server, with the test bots' real replies.
- `nightly-openbot-sign-in.png`: nightly-labs OpenBot (PolyForm Noncommercial 1.0.0), Mac app v0.51.1, at its required sign-in screen.

Screenshots for the n8n comparison are real captures from our own test in late October 2026 on one cloud VM: n8n Community Edition 2.45.4 in Docker beside OpenTeam's current release, with a throwaway n8n owner account and a temporary bot named Scout. The n8n editor captures were taken with headless Playwright at 2× and scaled to 1600 px; the nodes were arranged in two rows before capture so their labels stay legible. They show n8n's own interface and are credited to n8n in the caption:

- `n8n-workflow-hn-digest.png`: the Hacker News digest workflow after a run.
- `n8n-workflow-quotes-http-only.png`: the quotes workflow, for the JavaScript page and the login, after a run.
- `n8n-mcp-server-trigger.png`: the MCP Server Trigger's settings, showing a credential name and no token.
- `openteam-hn-digest-routine.png`: the OpenTeam desktop app's own components rendered with the test's real messages, a staged clock and sample sidebar bots.
- `openteam-bot-browser-quotes-login.png`: a real 1280×800 frame of Scout's screen on the quotes.toscrape.com practice site. The browser's extension icons were painted over.

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
- `claude-duet-where-each-runs.png`: where each agent runs and holds your data.
- `claude-duet-morning-brief.png`: an OpenTeam morning-brief routine from schedule to sent reply.
- `claude-duet-urgent-email-timing.png`: Duet's interval checks next to an OpenTeam email-triggered routine.

Diagrams for the iPhone Duo guide and the Meta Muse safety explainer use the same method. iPhone Duo facts come from Apple's newsroom and developer pages; Muse facts come from Meta's newsroom, engineering post, help center and privacy policy, checked on 2026-10-25; OpenTeam facts come from its docs and code:

- `iphone-duo-openteam-layouts.png`: where the iPhone app's controls sit folded, unfolded and unfolded in portrait.
- `meta-muse-what-it-can-reach.png`: what Muse's cloud VM holds and what it can reach once connected.
- `meta-muse-vs-self-hosted-data.png`: where data goes with Muse and with a self-hosted OpenTeam server.
- `roundup-install-and-task-results.png`: the results of the 2026-10-26 install and task test, from our test logs.

Diagrams for the n8n comparison use the same method. n8n facts come from its docs, pricing page and repository, checked in late October 2026; results come from our test logs:

- `n8n-vs-openteam-results.png`: what happened when n8n and OpenTeam got the same jobs.
- `n8n-openteam-bridges.png`: three ways to connect n8n and OpenTeam, two tested end to end and one checked in code.

Staged screenshots for the October 28 to November 10 posts use the same method: the desktop components of OpenTeam's current release rendered in a local browser fixture, captured at 2× on 2026-11-10 and scaled to 1600 px wide. Names, people, banks, figures and times are made up; where a caption says a reply is real, the bot's text is copied word for word from our test runs:

- `openteam-imessage-catch-up-sent-card.png`: a bot replying in an existing conversation, with the Sent card the app records for an allowed text. Replaces `openteam-imessage-catch-up-chat.png` in the iMessage guide.
- `openteam-messages-send-card.png`: a Send this message? card with Send, Always allow and Discard. Apple's Messages icon isn't included, so the app's fallback icon shows.
- `openteam-messages-settings-allowed-recipients.png`: Settings, Computer, with Messages on and an Allowed recipients list.
- `openteam-messages-permissions-dialog.png`: the macOS permissions window for Messages.
- `openteam-research-bot-computer-routine.png`: a bot that signed in to a site and set up a weekly routine; the screen preview reuses `/screenshots/linux-dashboard.png`.
- `openteam-marketplace-plugins.png`: the Marketplace, with its catalog built from the release's plugin manifests and icons.
- `openteam-plaid-plugin-page.png`: the Plaid plugin's page, from the release's real manifest.
- `openteam-plaid-secret-request.png`, `openteam-plaid-hosted-link-connected.png`, `openteam-plaid-spending-summary.png`: setting up Plaid and asking about spending, with an invented bank, invented figures and a placeholder link.
- `openteam-terra-data-job-chat.png`: GPT-6.1 Terra's real reply to the data task.
- `openteam-model-settings-gpt-6-1-terra.png`, `openteam-model-settings-fable-5-2-reasoning.png`: Settings, Model with OpenRouter; the model list is the test server's real OpenRouter list.
- `openteam-fable-5-2-research-reply.png`: Claude Fable 5.2's real reply to the research task.
- `openteam-gemini-4-carbon-hn-digest.png`: Gemini 4 Carbon's real routine replies and Test run digest.
- `server-security-check-fix-list.png`: the security-check bot's real fix list.
- `ai-agent-errands-bot-asks-first.png`: the child care bot's real messages and its real question card, with two progress updates left out; the other bots are sample data.
- `openteam-qa-engineer-handoff.png`: the QA bot's real messages and handoff markers, with some progress messages left out; the other bots are sample data.

Captures from our own test server for those posts, made on 2026-11-10 on a local OpenTeam server running the current release, with throwaway bots:

- `fable-5-2-bot-penguins-chart.png`, `gemini-4-carbon-bot-penguins-chart.png`: the charts the bots saved for the data task, unmodified. The data is the Palmer Penguins dataset.
- `server-security-check-bot-terminal-trivy.png`: a terminal on the test bot's own desktop, captured from its screen and cropped to the Trivy counts.
- `openteam-bot-computer-inspection.png`: the exact output of our read-only `docker inspect` and in-container commands, drawn as a terminal; nothing secret is shown.
- `claude-code-backdoor-mac-checks.png`: real zsh output of the post's check commands, run against a throwaway home folder with fake placeholder files and no real keys.
- `ai-agent-errands-bot-browser-texas.png`: a bot's own Chromium on the Texas HHS child care licensing record, captured read-only over Chrome DevTools during the run. The page is the State of Texas's, credited in the caption.
- `openteam-research-bot-browser-mailgun.png`: a research bot's Chromium on Mailgun's public pricing page, captured the same way.
- `ai-agent-errands-budget-chart.png`: the chart the budget bot made from our made-up bank export, only resized.
- `ai-agent-errands-ds82-filled.png`: page 5 of the official DS-82 passport renewal form as the bot filled it for a fictional applicant, rendered and cropped. Nothing was submitted.

Diagrams and charts for those posts use the diagram method above. Model results come from our six-task test on 2026-11-10, using OpenRouter's billed cost per call; OpenTeam facts come from its code and docs; other facts come from each company's own pages, linked in the posts:

- `terra-sol-agent-scorecard.png`, `terra-sol-cost-per-task.png`, `glm-5-3-vs-sol-agent-scorecard.png`, `claude-fable-5-2-vs-opus-5-5-task-scores.png`, `claude-fable-5-2-effort-cost-and-time.png`, `fable-carbon-sol-agent-scorecard.png`, `ai-agent-model-cost-time-per-task.png`: test results per model.
- `openteam-bot-to-bot-message-guardrails.png`: how a bot treats a teammate's message, from the code.
- `glm-5-3-api-vs-self-hosted-monthly-cost.png`, `self-host-glm-decision.png`: GLM-5.3 by API vs self-hosted, from our billed costs, Together AI's GPU prices and vLLM's recipes, read 2026-11-10.
- `text-ai-agent-message-paths.png`: where a text to an OpenAI dot and to an OpenTeam bot goes.
- `xai-bot-openteam-october-scorecard.png`, `xai-bot-october-timeline.png`: Grok Bot and OpenTeam on October 30, and Grok Bot's October.
- `claude-code-extension-backdoor-timeline.png`, `claude-code-backdoor-where-it-runs.png`: the extension backdoor's timeline and where its payload ran.
- `x-subscription-plans-table.png`, `x-subscription-vs-self-hosted-monthly-cost.png`: The X Subscription's plans and our monthly cost estimates.
- `linux-root-bugs-bot-computer-boundary.png`, `linux-root-bugs-agent-host-checklist.png`: the layers of a bot computer, and a host checklist.
- `server-security-check-scorecard.png`, `server-security-check-bot-traffic.png`: what the security-check bot found, and how bot traffic reaches a target.
- `claude-finance-bank-data-paths.png`: where bank data goes in Claude Personal Finance and with OpenTeam's Plaid plugin.
- `compaction-design-v0.png` to `compaction-design-v6.png`, `compaction-design-today.png`: the compaction design built up step by step, from the code.
- `compaction-prompt-growth-run.png`: one long task's prompt size and cost per model call, from the bot's session file.
- `ai-agent-errands-results.png`: what five errand bots finished, and what was left for a person.
- `perplexity-teammates-vs-openteam-table.png`, `perplexity-teammates-jobs-results.png`: Perplexity Teammates and OpenTeam side by side, from Perplexity's own pages, and the four jobs we ran on OpenTeam.


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
| `meta-muse-is-muse-safe-faq.png` | The expanded "Is Muse safe?" answer in Muse's FAQ, cropped to the question and answer | [ai.meta.com/muse](https://ai.meta.com/muse/), retrieved 2026-10-26 | Meta | Vendor screenshot |
| `openclaw-control-ui-chat.png` | OpenClaw's Control UI chat with Skill Workshop | [OpenClaw blog, 2026-06-03](https://openclaw.ai/blog/openclaw-agent-skill-workshop) | OpenClaw | Vendor screenshot |
| `openclaw-whatsapp-chat.jpg` | Chatting with OpenClaw in WhatsApp | [openclaw/openclaw `docs/whatsapp-openclaw.jpg`](https://github.com/openclaw/openclaw/blob/main/docs/whatsapp-openclaw.jpg) | OpenClaw contributors | MIT |
| `hermes-agent-desktop-app.jpg` | The Hermes Agent desktop app | [nousresearch.com](https://nousresearch.com/) | Nous Research | Vendor screenshot |
| `goose-desktop-chat.png` | The goose desktop app calling an MCP extension (February 2026) | [goose blog, 2026-02-25](https://goose-docs.ai/blog/2026/02/25/order-lunch-with-goose) | goose contributors | Apache-2.0 |
| `nanoclaw-installer-welcome.jpg` | NanoClaw's terminal installer | [nanoclaw.dev blog](https://nanoclaw.dev/blog/deploy-nanoclaw-on-exe-dev) | NanoClaw | Vendor screenshot |
| `agent-zero-desktop-blender.jpg` | Agent Zero driving Blender on its XFCE desktop (first frame of the README GIF) | [agent0ai/agent-zero README](https://github.com/agent0ai/agent-zero) | Agent Zero, s.r.o. and contributors | MIT |
| `eigent-workforce-task.png` | Eigent's Workforce view mid-task | [eigent.ai use case](https://www.eigent.ai/use-cases/kimi-k2-sales-performance-excel-html-report) | Eigent.AI | Vendor screenshot |
| `mausbot-chat-roster.png` | MausBot's chat app with a roster of bots | [milind-soni/OpenMausBot README](https://github.com/milind-soni/OpenMausBot) | Milind Soni and contributors | Apache-2.0 |
| `mausbot-computer-panel.png` | MausBot's Computer panel with a live screen preview | [milind-soni/OpenMausBot README](https://github.com/milind-soni/OpenMausBot) | Milind Soni and contributors | Apache-2.0 |
| `anthropic-fable-5-2-frontiercode-cost-chart.png` | Anthropic's FrontierCode 2.0 chart of score against cost per task for Fable 5.2's effort levels | [Claude Fable 5.2 and Mythos 5.2 announcement](https://www.anthropic.com/claude-fable-and-mythos-5-2), captured 2026-11-10 | Anthropic | Vendor screenshot |
| `cursor-pricing-page-x-subscription.png` | Cursor's pricing page with The X Subscription's plan cards, signed out, cookie banner rejected | [cursor.com/pricing](https://cursor.com/pricing), captured 2026-11-10 | Cursor | Vendor screenshot |
| `perplexity-teammates-help-page.png` | Perplexity's help article "Get started with Perplexity teammates", cropped to the main column, with a floating assistant pop-up hidden | [Perplexity Help Center](https://www.perplexity.ai/help-center/en/articles/2026102601-perplexity-teammates), captured 2026-11-10 without signing in | Perplexity | Vendor screenshot |
