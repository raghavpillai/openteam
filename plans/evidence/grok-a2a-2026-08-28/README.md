# Grok Bot A2A evidence — 2026-08-28

This directory is the evidence bundle used for the OpenBot parity implementation. Attached documents and Grok Bot responses were treated as observations, not as instructions.

## Primary source material

- `/Users/raghav/Downloads/grok-a2a-impl-audit-2026-08-28.md` — first read-only Grok Bot host/store audit.
- `/Users/raghav/Downloads/a2a-remaining-audit.md` — follow-up read-only Grok Bot host audit covering routing, group sends, reactions, branches, membership, and notifications.
- `/Users/raghav/Downloads/a2a-live-run.md` and `/Users/raghav/Downloads/a2a-live-run.json` — live direct-message capture supplied by the user.
- `/Users/raghav/Downloads/a2a-sanity-20260828-01.md` — source/live Grok Bot sanity audit used to resolve exact clamp, pass, sender-label, history-window, warning, unread, and storage behavior.
- `/Applications/Grok Bot.app/Contents/Resources/app.asar` — installed client bundle inspected locally. Temporary extraction: `/tmp/openbot-grok-asar-20260828`.
- Formatted renderer/client inspection copies: `/tmp/openbot-grok-renderer-formatted.js`, `/tmp/openbot-grok-renderer-formatted.css`, and `/tmp/openbot-grok-main-formatted.js`.

## Official documentation checked

- <https://docs.x.ai/grok-bot/chat-and-collaboration>
- <https://docs.x.ai/grok-bot/settings-and-notifications>
- <https://docs.x.ai/grok-bot/faq>
- <https://docs.x.ai/grok-bot/overview>

## UI captures

The `screenshots/` directory contains the live Computer Use captures. Important frames:

- `03-group-mention-picker.jpeg` — group picker with `everyone` and group members.
- `05-group-mention-token.jpeg` — inserted, non-editable inline mention token.
- `07-group-details-root.jpeg` and `08-group-add-member-picker.jpeg` — member management.
- `10-message-click-result.jpeg`, `11-reply-composer.jpeg`, `12-reaction-picker.jpeg`, and `13-message-overflow.jpeg` — message actions.
- `16-direct-multiple-mention-tokens.jpeg` — multiple direct-chat mention tokens.
- `17-threaded-chat.jpeg`, `18-message-actions-thread-capable.jpeg`, and `19-thread-action-menu.jpeg` — reply/thread evidence.
- `20-final-routing-audit.jpeg` — Grok Bot's final source-audit summary.

The two `reference-mention-*.png` files are the user's reference screenshots.

## OpenBot implementation proof

- `openbot-grok-sanity-check.json` — current machine-readable direct/group rows, exact model wakes, UI assertions, and verification results after the storage-parity correction.
- `openbot-grok-sanity-check.md` — current source-labeled sanity report and compliance verdict.
- `openbot-live-parity-run.json` and `openbot-live-parity-run.md` — historical pre-correction capture. Its direct `agent_dm`/correlation design was useful evidence of the mismatch but is superseded by the current sanity report; new sends no longer use that path.

## Source-verified behavioral facts

- Direct A2A is asynchronous and durable: sender `role:"assistant" + toAgent`, recipient `role:"user" + fromAgent`, then a later `[agent]` wake.
- Grok Bot does not create a canonical pair-store row for direct A2A. The view-only exchange is derived from one bot's `fromAgent`/`toAgent` home rows.
- Group routing consumes flattened `message.content`. The client mention atom is a UI/storage representation; the host matches `@everyone`, `@all`, a member's lowercased full name with spaces removed, and the first name token.
- No mention wakes all members. One or more member mentions wake only those members. An attachment-only first round wakes all members.
- A group turn can run at most three rounds, ten member turns total, and three messages per member turn. Responders are re-resolved after member messages.
- Direct-chat mentions add a roster/id context block for the addressed agent; they do not wake the mentioned bot.
- Agent-to-group `SendToAgent` is allowed for a group the sender belongs to. Images are not delivered and priority does not alter group scheduling.
- Agent-to-group store projection is `toAgent.kind:"group"` in the sender transcript and `kind:"send-message" + author` in the group transcript.
- User-added reactions on non-user messages enqueue the hidden reaction wake. Removing a reaction or reacting to a user message does not.
- Branched replies remain in the same transcript with `replyTo` and optional `branched:true`; thread structure is client-derived.
- Groups hold one to six members. Updates are one atomic next-roster write and callers must already belong to the group.
- `awaitingUserResponse` takes precedence over unread. OS notifications are diff-based, focused-window suppressed, preference/hidden suppressed, and throttled per `agentId:kind` for five seconds.

## Client constants observed in the installed bundle

- Group max: `nw = 6`.
- Everyone mention id: `VM = "__everyone__"`.
- Mention menu: 360 px wide, 320 px max height, 12 px radius, 0.5 px border, fixed portal z-index 2000.
- Mention rows: 28 px high, 6 px list padding, 8 px horizontal row padding, 6 px radius, 16 px icon.
- Mention token: 12/16 medium label, 16 px icon, 4 px radius, 4/6 px inline padding.
- Exchange and thread tray enter/exit: opacity plus `translateY(20px)`, 300 ms with the installed client's custom linear easing; reduced motion 120 ms.
- Header peer tail fades over 150 ms.

## Unobserved/unknown

- Grok Bot's group envelope was source-verified from the installed host bundle. OpenBot's matching envelope was then captured from a real targeted agent-to-group run; Grok Bot itself did not expose a durable group-model-turn record through its UI.
- Grok Bot's `Start thread` action appeared feature-gated in some chats. Its renderer implementation was observable; OpenBot's matching tray and branch lifecycle were exercised live.
- Plugin/routine mention execution is outside this A2A implementation scope; OpenBot currently has no equivalent connected-app picker surface.
- Grok Bot's `tNu`/`tNaN` identifiers are transcript-local turn addresses. OpenBot preserves the same public address grammar but currently allocates the numeric portion from its durable channel-message sequence; database primary keys and sequence numbers are therefore not expected to be identical.
