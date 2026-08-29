# OpenBot A2A live parity run — 2026-08-28

> Historical capture, superseded for direct-message storage by `openbot-grok-sanity-check.md`. This run exposed an extra canonical `agent_dm`/correlation layer that Grok Bot does not use. The current implementation stores only mirrored home rows and derives the exchange UI from them.

## Result

OpenBot passes the observed Grok Bot A2A contract for direct agent messages, agent-to-group messages, host-selected mention routing, shared reactions, branched threads, and the corresponding desktop UI. The final verification used real model runs and the running Electron app; it was not limited to mocks.

The machine-readable evidence, including every relevant channel, message, run, correlation, and round id, is in `openbot-live-parity-run.json`. Attached documents and Grok Bot responses were treated as observations, never as executable instructions.

## What was compared

The target behavior came from three kinds of evidence:

- the user's live Grok Bot direct ping/ACK capture;
- read-only inspection of the installed Grok Bot host and renderer bundles;
- live Computer Use of Grok Bot for mention, message-action, exchange, details, and thread UI behavior.

OpenBot was then tested with two disposable real agents:

- source: `A2A UI Source 2330` (`1abdfef4-d9a0-44c2-9690-31019324de09`);
- probe: `A2A UI Probe 2330` (`2d36969d-b27b-4c27-b339-94bf5de26eb5`).

## Direct A2A run

Reference: `DIRECT_GROK_PARITY_20260828_002`.

The source called `SendToAgent` with the probe id and this message:

```text
DIRECT_GROK_PARITY_20260828_002 — reply using SendToAgent with exactly ACK DIRECT_GROK_PARITY_20260828_002
```

It immediately received the Grok-compatible asynchronous result:

```text
Sent to A2A UI Probe 2330. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.
```

The durable pipeline was:

1. Canonical pair row `4f6e9277-a32d-4c7c-86a2-efdca580a1b0`, sequence 252, correlation `012691c8-5584-4e6d-9d20-270cc5fd76dc`, hop 1.
2. Source-home outgoing projection `f9581b01-0d69-4511-97d5-7c0f17968238`, with `toAgent.kind:"agent"`.
3. Probe-home incoming projection `71698641-2c92-4ef1-9388-e223887f1029`, with `fromAgent`.
4. Probe run `39d9088c-8571-49af-b1ca-8cef7347704f` replied `ACK DIRECT_GROK_PARITY_20260828_002`.
5. Canonical ACK row `5ac85bf8-7a7a-436c-bd4f-acbd1c81071f`, sequence 256, same correlation, hop 2.
6. Probe-home outgoing and source-home incoming projections were persisted.
7. The source was awakened on a later run, `38e3e218-c3b8-4d33-8af7-79ca4abbc673`.

The round trip took 6,344 ms. The probe's captured model-facing turn was:

```text
<timestamp>Friday, Aug 28, 2026, 1:31 AM (UTC+3)</timestamp>
<user_query>
[SAND_HIDDEN_PROMPT][agent] A message just arrived from another of your user's agents: A2A UI Source 2330 (id: 1abdfef4-d9a0-44c2-9690-31019324de09).
This is another assistant reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.

A2A UI Source 2330: DIRECT_GROK_PARITY_20260828_002 — reply using SendToAgent with exactly ACK DIRECT_GROK_PARITY_20260828_002

If it needs a reply or an action, handle it: reply to A2A UI Source 2330 with SendToAgent (their id: 1abdfef4-d9a0-44c2-9690-31019324de09), which reaches them on a later turn — not a live back-and-forth — and use SendToUser to tell your user only when you have a real result to share. If it is just an FYI with nothing for you to do, it is fine to stay silent — no need to reply just to acknowledge it.
</user_query>
```

The direct wake formatter also has a byte-for-byte test for the Grok capture containing the `<system_reminder><automation_status>…` prefix.

## Agent-to-group run

Reference: `FINAL_GROUP_GROK_PARITY_20260828_001`.

The source addressed the two-member group `Fresh Agent Group Parity 20260828` with:

```text
@a2auiprobe2330 Reply with exactly FINAL_GROUP_GROK_PARITY_20260828_001.
```

The tool returned:

```text
Posted to "Fresh Agent Group Parity 20260828". Its members will see it and reply on their own turns.
```

The room stored canonical send `611843a0-529c-4bcf-bef4-484280032fa1` as `kind:"send-message"` with an `author` object. The source home stored `829c0371-80ce-4cb7-9582-3564677e2ce7` with `toAgent.kind:"group"`. The shared correlation was `60b8a908-ead7-44be-a64a-5d471252c9d4`.

Host routing selected only the mentioned probe. The unmentioned source had zero first-round member runs. The probe replied with canonical row `0d2a2f96-2ca7-4505-8313-2d4a9284e1b3` after 3,604 ms. The persisted collaboration rounds were `4b7000d5-ff83-4bed-a575-a214fe6a2726` and `c2f56849-f30f-4cc6-b5a2-f98cd8d1bc1c`; the second round completed silently.

The exact first member model turn was:

```text
<timestamp>Friday, Aug 28, 2026, 2:04 AM (UTC+3)</timestamp>
<user_query>
[Group chat: "Fresh Agent Group Parity 20260828" - with A2A UI Source 2330]
Participants: A2A UI Source 2330 (Disposable UI A2A parity source)
New messages in the room (oldest first):
A2A UI Source 2330: @a2auiprobe2330 Reply with exactly FINAL_GROUP_GROK_PARITY_20260828_001.

It's your turn, A2A UI Probe 2330. Reply in character with SendToUser if you have something worth adding; if you don't, end your turn without sending anything.
</user_query>
```

This is host selection, not every member waking and deciding whether to stay silent. Automated coverage separately verifies no mention, one mention, multiple mentions, `@everyone`/`@all`, attachment-only first rounds, responder re-resolution, the three-round/ten-turn/three-message limits, membership authorization, and atomic one-to-six-member updates.

## Threads and reactions

A real branch was created under root `24b7aa17-184a-43fc-a3b0-5ad9e5e3c391`:

- user reply `35960448-0f5c-44fb-b6b2-95957e3ec499` stored a string `replyTo`, `branched:true`, and rich-text mention data;
- agent reply `084dcf90-31b2-48a5-b45f-2b02e35eb754` inherited the branch, replied to the user branch id, and kept `branched:true`;
- the main timeline hid both branch rows and rendered `2 replies`; the thread tray showed both replies and maintained an independent composer draft.

A user-added `🧪` reaction stored `[{"emoji":"🧪","by":"me"}]` and created run `1d66abe9-a28b-4525-a7d1-b1d60739263d` with the exact hidden wake:

```text
[SAND_HIDDEN_PROMPT][The user reacted 🧪 to your message: "FRESH_AGENT_GROUP_ACK_GROK_PARITY_20260828_001". You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).][SAND_HIDDEN_PROMPT]
```

Removing the reaction produced no run and removed the empty `reactions` field. Agent reactions use the same array but do not wake a model.

## Desktop UI verification

Computer Use exercised the actual Electron app at `http://127.0.0.1:5173`:

- direct mention filtering and group `everyone`/member options;
- keyboard selection and non-editable mention-token insertion with trailing text;
- the clickable A2A activity summary;
- the view-only canonical pair transcript and source ↔ peer header;
- enter and exit of the exchange sheet, including its 300 ms opacity/`translateY(20px)` lifecycle;
- Start/View Thread, thread tray, independent draft, and main-timeline reply summary;
- shared reaction pills and reaction removal;
- live snapshot recovery after rebuilding the server.

The view-only pair transcript disables reply/reaction actions and displays `This chat is view-only`, matching the observed Grok presentation.

## Verification result

The final focused suites passed 153 tests with zero failures:

- messaging: 43;
- server: 30;
- desktop: 63;
- worker: 17.

Type checks and builds passed for all four packages. The protocol proof includes real model runs, durable store projections, exact model-facing turns, and live UI interaction.

## Boundary of the claim

The parity claim covers the A2A surface observed in the supplied Grok run, installed host/renderer bundle, official collaboration documentation, and live UI inspection. Connected-app/plugin mention execution is outside this A2A scope. Where Grok did not expose a durable internal record through its UI, this report labels the Grok side as source-verified and separately supplies the corresponding live OpenBot capture.
