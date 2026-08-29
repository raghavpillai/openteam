# Grok Bot A2A parity specification

Evidence: `plans/evidence/grok-a2a-2026-08-28/README.md`.

## Required protocol behavior

1. Preserve the observed direct A2A rows, acknowledgements, priority scheduling, delayed model wake, routine-status wrapper, and visible exchange projection.
   - Sender home projection: `role:"assistant"` with `toAgent:{id,name,kind:"agent"}`.
   - Recipient home projection: `role:"user"` with `fromAgent:{id,name}`.
   - There is no canonical pair-channel row, correlation id, `hopCount`, TTL, or autonomous A2A chain budget in the Grok Bot store path. Each hop is represented only by the two home-chat rows above.
   - A normal recipient wake is the exact `[SAND_HIDDEN_PROMPT][agent] A message just arrived...` envelope captured from Grok Bot; routine status, when present, precedes `[agent]` inside the same hidden-prompt prefix.
   - Peer and group model wakes are injected directly as their host-authored envelope. They are not wrapped in a normal user `<timestamp><user_query>` envelope.
   - The sender receives the exact asynchronous acknowledgement immediately; the recipient reply arrives only as a later model turn.
2. Store group user messages with flattened content and optional ProseMirror-compatible `richText`.
3. Parse routing from flattened content:
   - `@everyone` or `@all` selects all members;
   - matched `@Name` handles select only those members;
   - no matched mentions selects all members;
   - attachment-only first round selects all members.
4. Run ordered group collaboration for at most three rounds, ten member turns, and three visible messages per member turn. Re-resolve responders after each round. Do not wake unselected members.
   - The group model turn begins `[Group chat: "<name>" - with <peers>]`.
   - Include `Participants: Name (description)` only for peers that have descriptions.
   - Render `New messages in the room (oldest first):`, `User:`/agent-name lines, and `[in reply to ...]` exactly as observed in the host bundle.
   - Finish with `It's your turn, <name>. Reply in character with SendToUser...`; use the observed attachment, no-new-message, redelivery, and wind-down variants when applicable.
5. Permit agent-to-group sends only for member agents. Keep group posts text-only and ignore priority for scheduling. Project the sender row as `toAgent.kind:"group"` and the room row as `send-message + author`.
6. Enforce group membership atomically with one to six active top-level bots, no nested groups, and caller-membership authorization for agent tools.
7. Store reactions in the shared `reactions` array:
   - user: `{emoji,by:"me"}`;
   - direct agent: `{emoji,by:"agent"}`;
   - group agent: `{emoji,by:"<agent UUID>"}`.
   Enqueue the exact observed reaction hidden prompt only when the user adds a reaction to an agent entry. Removing it, reacting to a user entry, and an agent reaction do not create a model wake.
8. Keep ordinary inline replies and branched threads distinct. Store branches in the same transcript using string `replyTo` plus `branched:true`; pass `replyToMessageId` and `isFork` through wake/tool context without storing `isFork`; derive thread summaries client-side.
9. Address user messages as `t<sequence>u` and assistant messages as `t<sequence>a0` unless an explicit address exists. Persist `replyTo` as a string message id, never an embedded object.

## Required desktop behavior

1. Mention picker:
   - direct chat: active bots;
   - group chat: `everyone` plus current members;
   - filter while typing; Arrow Up/Down wrap; Enter/Tab select; Escape dismiss;
   - insert a non-editable inline token plus a trailing space;
   - allow multiple tokens and regular trailing text;
   - serialize both flattened text and ProseMirror-compatible `richText`.
2. Group details:
   - member list, remove controls, Add Member picker, one-to-six validation;
   - save the complete next roster atomically.
3. Message actions:
   - click/hover action toolbar, reactions, ordinary Reply, Start/View Thread, copy.
4. Thread tray:
   - root, reply count, branched replies, independent composer and draft;
   - 300 ms opacity/translate animation matching the exchange overlay family;
   - main timeline hides branched rows and shows a summary chip under the root.
5. Attention and notifications:
   - Needs attention takes precedence over unread; working remains separate;
   - notify on running→done and first awaiting-user transition only;
   - suppress while focused, hidden, or disabled; throttle five seconds per channel/event kind;
   - clicking the OS notification focuses the app and opens the relevant chat.

## Acceptance tests

- Direct ping/ACK store and wake parity stays green.
- No-mention, one-mention, multi-mention, and everyone group routing select the expected delivery set.
- Group caps, membership authorization, atomic update, and responder re-resolution are covered.
- Direct and group mention picker keyboard/token/serialization behavior is covered.
- Ordinary reply and branched thread storage/UI paths are covered independently.
- Reaction wake positive and negative cases are covered.
- Notification transition/suppression/throttle logic is covered without showing real OS notifications in unit tests.
- Desktop UI is exercised in the running Electron app after focused and full checks pass.
- A live direct send/ACK, targeted agent-to-group send/ACK, branched reply, reaction add/remove, exchange-sheet enter/exit, and mention-token flow are captured in the evidence bundle.
- New direct sends do not create an `agent_dm` database channel or write `a2a`, `a2aProjection`, `canonicalMessageId`, `correlationId`, `hopCount`, or TTL metadata. The exchange screen is derived from the selected bot's home rows.
