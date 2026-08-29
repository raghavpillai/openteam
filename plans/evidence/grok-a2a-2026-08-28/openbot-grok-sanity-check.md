# OpenBot ↔ Grok Bot A2A sanity check — 2026-08-28

## Verdict

OpenBot now matches the observable Grok Bot A2A contract for direct sends, delayed peer wakes, replies, group posts, group routing, group warning strings, home-row persistence, unread behavior, and the view-only exchange UI.

The result is not a claim that OpenBot and Grok Bot share database primary keys or the same runtime. Grok Bot's `tNu`/`tNaN` numbers are transcript-local; OpenBot uses its durable channel-message sequence for the numeric part. The public address grammar and reaction behavior match, but numeric allocation is implementation-local.

## Evidence labels

- **OFFICIAL** — public Grok Bot documentation.
- **GROK LIVE** — a response or UI behavior observed in the signed-in Grok Bot app.
- **GROK SOURCE** — behavior read from the installed Grok Bot host/renderer bundle.
- **OPENBOT LIVE** — a real OpenBot model run, database row, or running Electron UI observation.
- **TEST** — automated verification.

## High-level comparison

- **OFFICIAL / GROK LIVE:** A direct handoff is fire-and-forget. The receiver wakes later and can reply on a later turn.
- **OPENBOT LIVE:** `OPENBOT_DIRECT_WRAPPER_FINAL_20260828_01` produced the exact asynchronous acknowledgement, then an ACK 5.390 seconds after the outbound pair landed.
- **OFFICIAL / GROK LIVE:** A Bot can post into a group it belongs to. Bot-to-group images are text-only and group priority is ignored.
- **OPENBOT LIVE:** `OPENBOT_GROUP_FINAL_20260828_01` returned both exact warning sentences, stored no image/priority metadata, and raised unread on the room rather than the peer home chats.
- **GROK SOURCE / OPENBOT LIVE:** Clicking a compact A2A activity opens a derived, view-only source ↔ peer exchange with `This chat is view-only` and `Close Chat`. No canonical pair-store row is required.
- **GROK LIVE / OPENBOT LIVE:** The group composer supports `everyone` and current-member mention suggestions; selecting a room clears unread.

Official product coverage: [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration), [Grok Bot overview](https://docs.x.ai/grok-bot/overview), and [Create and manage Bots](https://docs.x.ai/grok-bot/bots).

## Defects found and fixed during the sanity check

1. OpenBot originally created a canonical `agent_dm` row with `correlationId`, `hopCount`, TTL, and projection metadata. **GROK SOURCE** showed that Grok Bot stores only the sender-home `toAgent` row and recipient-home `fromAgent` row. New OpenBot sends now do the same; the exchange UI derives its transcript from home rows.
2. Group image/priority requests originally returned only the base acknowledgement. OpenBot now returns Grok Bot's exact singular/plural image warning and exact priority-ignored warning.
3. The generic wake path wrapped peer/group host envelopes in `<timestamp><user_query>`. Grok Bot injects those host envelopes directly. OpenBot peer and group model messages now start directly at `[SAND_HIDDEN_PROMPT]` or `[Group chat: ...]`.
4. OpenBot now applies Grok Bot's exact `trim().slice(0, 8000)` clamp, group `(pass)` variants, empty-message results, reply-quote clamp, last-24 group history, sender labels, self-send error, reaction-address error, and priority-supersession reason.
5. Peer A2A home projections no longer create unread activity. Group `send-message` rows do.
6. The exchange screen now uses the source home transcript, including the 300 ms opacity + `translateY(20px)` enter/exit lifecycle, view-only actions, source ↔ peer header, and focus restoration.

Historical rows made before this correction remain in the local database; they were not deleted because they are user data. The application hides legacy `agent_dm` channels and creates no new ones.

## Final direct pipeline

Reference: `OPENBOT_DIRECT_WRAPPER_FINAL_20260828_01`.

1. **OPENBOT LIVE:** source home outgoing row, sequence 318, role `agent`, metadata only `toAgent:{id,name,kind:"agent"}`.
2. **OPENBOT LIVE:** probe home incoming row, sequence 319, role `user`, metadata only `fromAgent:{id,name}`. It has the same timestamp as the source row.
3. **OPENBOT LIVE:** source-visible result, sequence 320:

   ```text
   Sent to A2A UI Probe 2330. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.
   ```

4. **OPENBOT LIVE:** the probe's model-facing message began directly with this text—there was no timestamp/user-query wrapper:

   ```text
   [SAND_HIDDEN_PROMPT][agent] A message just arrived from another of your user's agents: A2A UI Source 2330 (id: 1abdfef4-d9a0-44c2-9690-31019324de09).
   This is another assistant reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.

   A2A UI Source 2330: OPENBOT_DIRECT_WRAPPER_FINAL_20260828_01 — reply via SendToAgent with exactly ACK OPENBOT_DIRECT_WRAPPER_FINAL_20260828_01

   If it needs a reply or an action, handle it: reply to A2A UI Source 2330 with SendToAgent (their id: 1abdfef4-d9a0-44c2-9690-31019324de09), which reaches them on a later turn — not a live back-and-forth — and use SendToUser to tell your user only when you have a real result to share. If it is just an FYI with nothing for you to do, it is fine to stay silent — no need to reply just to acknowledge it.
   ```

5. **OPENBOT LIVE:** probe home outgoing ACK row, sequence 321; source home incoming ACK row, sequence 322. Both were persisted at `2026-08-27T23:50:42.909Z`, 5.390 seconds after the outbound pair.
6. **OPENBOT LIVE:** the source then received the same direct `[SAND_HIDDEN_PROMPT][agent]` wake for the ACK and completed silently as requested.
7. **OPENBOT LIVE:** zero `agent_dm` channels were created during the run, and no new A2A row contains `a2a`, `a2aProjection`, `canonicalMessageId`, `correlationId`, `hopCount`, or TTL metadata.

## Final group pipeline

Warning reference: `OPENBOT_GROUP_FINAL_20260828_01`. Prompt reference: `OPENBOT_GROUP_WRAPPER_FINAL_20260828_01`.

- **OPENBOT LIVE:** the image + priority call returned exactly:

  ```text
  Posted to "Fresh Agent Group Parity 20260828". Its members will see it and reply on their own turns. Note: the attached image was NOT delivered — group messages are text-only for now; send images to an agent directly. Note: priority is 1:1 only — this post did not interrupt members.
  ```

- **OPENBOT LIVE:** the room stored `kind:"send-message"`, an `author` object, and a text `message`. The source home stored only `toAgent.kind:"group"`. Neither row stored images, priority, correlation, hop, or TTL.
- **OPENBOT LIVE:** the mention selected only A2A UI Probe 2330. Its first model message began directly with:

  ```text
  [Group chat: "Fresh Agent Group Parity 20260828" - with A2A UI Source 2330]
  Participants: A2A UI Source 2330 (Disposable UI A2A parity source)
  New messages in the room (oldest first):
  A2A UI Source 2330: @a2auiprobe2330 Reply with exactly ACK OPENBOT_GROUP_WRAPPER_FINAL_20260828_01.

  It's your turn, A2A UI Probe 2330. Reply in character with SendToUser if you have something worth adding; if you don't, end your turn without sending anything.
  ```

- **OPENBOT LIVE:** the probe posted one ACK. A later wrap-up turn saw `A2A UI Probe 2330 (you): ...` and completed silently, demonstrating source-verified viewer labeling and bounded collaboration.

## UI validation

Computer Use exercised the running Electron development client after the rebuilt server/worker were healthy:

- clicked `2 messages with A2A UI Probe 2330`;
- verified the source ↔ peer header, both directions of the transcript, disabled reply/reaction actions, `This chat is view-only`, and `Close Chat`;
- closed the exchange and opened the group room;
- verified the room transcript, author grouping, reply summary, unread clearing, and normal writable composer;
- typed `@` without sending and verified `everyone`, `A2A UI Probe 2330`, and `A2A UI Source 2330` suggestions;
- verified source code parity for the 300 ms opacity/20 px translate animation and the 150 ms header-tail fade.

## Verification

- **TEST:** repository typecheck — 8/8 workspaces successful.
- **TEST:** repository tests — 11/11 Turbo tasks successful; focused messaging suite 44 passed, server suite 31 passed.
- **TEST:** production build — 8/8 workspaces successful.
- **OPENBOT LIVE:** Docker server/worker rebuilt and healthy twice, including after the final prompt-layer correction.
- **OPENBOT LIVE:** direct round trip, exact direct model wake, group warning flow, exact group model turn, unread split, exchange UI, group UI, and mention picker all exercised.

## Last release-style pass

Captured at `2026-08-28T12:22:01+03:00`.

- **OPENBOT LIVE:** `OPENBOT_A2A_LASTPASS_DIRECT_20260828_01` produced four mirrored direct rows, an ACK after 7.076 seconds, two directly injected `[SAND_HIDDEN_PROMPT][agent]` wakes, zero forbidden metadata fields, and zero new `agent_dm` channels.
- **OPENBOT LIVE:** `OPENBOT_A2A_LASTPASS_GROUP_20260828_01` produced one exact targeted room post and one ACK after 3.891 seconds. Its group wakes were directly injected and the bounded self-post pass completed silently.
- **DEFECT FOUND AND FIXED:** the bounded self-post pass exposed an expected run-lease race as a handled PostgreSQL duplicate-key error. Lease acquisition now uses `createMany(..., skipDuplicates: true)` plus a transaction-local contention sentinel, so the losing transaction rolls back without emitting a database error.
- **OPENBOT LIVE:** the post-fix contention probe `OPENBOT_A2A_LASTPASS_GROUP_20260828_02` produced one exact targeted post and one ACK after 4.164 seconds, completed all source/probe runs, preserved exact unwrapped group prompts, and left the service log error scan clean.
- **OPENBOT LIVE / COMPUTER USE:** the desktop package was rebuilt from the current tree. The latest `2 messages with A2A UI Probe 2330` activity opened the complete transcript through the last-pass ACK in the view-only animated sheet; `Close Chat` restored the source; the room showed the post-fix exchange; and `@` exposed `everyone`, source, and probe. The draft was cleared without sending.
- **TEST:** after the lease fix, repository typecheck was 8/8, tests were 11/11 Turbo tasks, production build was 8/8, `git diff --check` passed, health was fully ready, and all final source/probe runs were terminal.

Machine-readable evidence is in `openbot-grok-sanity-check.json`.
