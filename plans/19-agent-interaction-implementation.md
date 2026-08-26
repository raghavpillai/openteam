# Agent interaction and group-chat implementation

Status: implemented and integration-tested  
Last updated: 2026-08-25

> Runtime update: this feature originally shipped on one Codex thread per bot and now runs on one Pi session per bot. Postgres channel/mailbox semantics, tool contracts, ordering, and privacy invariants are unchanged. Current host details are in `27-pi-agent-runtime.md`.

## Outcome

OpenBot keeps one native Pi session per bot while giving that durable actor multiple delivery addresses:

- its user-facing bot DM;
- a private agent-to-agent channel for each peer pair;
- any group rooms it belongs to.

An address is not a new model session. A message creates a new turn on the recipient bot's existing Pi session. Postgres owns visible channel history, durable inboxes, group rounds, and delivery state; the Pi JSONL session owns model context and compaction.

## Runtime path

```text
Pi session for bot A
  -> item/tool/call: SendToAgent
  -> authenticated computer-to-server callback
  -> validate active run/bot/conversation/channel capability
  -> commit ChannelMessage + recipient InboxEvent + Run + pg-boss wake
  -> acknowledge immediately

worker claims bot B's mailbox
  -> reopens bot B's native Pi session
  -> bot B optionally calls SendMessage
  -> visible ChannelMessage in the agent DM
  -> a later reply wake is queued for bot A
```

The sender never waits or polls during its original turn. A reply is a separate durable event and fresh turn.

## Exact observed tool contracts

These are preserved 1:1 from the supplied Grok investigation. OpenBot registers the same argument shapes. Its production `SendMessage` description substitutes the OpenBot product name for “Grok Bot.”

```json
{
  "tool": "SendToAgent",
  "description": "Send a message to ANOTHER of your user's agents, OR post into a GROUP chat you belong to, by its id (not the user — SendMessage is how you reach the user). This is FIRE-AND-FORGET and asynchronous, like texting: it delivers your message, wakes that agent (or the group's members), and returns immediately with a delivery acknowledgement. Peer messages run ahead of routines and other background work; pass priority=true on a 1:1 send to interrupt the recipient's current non-user turn (STOP / supersede), like a direct user message (ignored for groups). It does NOT return their reply, and you must not wait or poll for one in this turn — send it and move on. Any reply arrives later as its own message that wakes you on a fresh turn.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_id": {
        "type": "string",
        "minLength": 1,
        "description": "The id of the target — either another agent or a GROUP you belong to."
      },
      "message": {
        "type": "string",
        "minLength": 1,
        "description": "What to say. Write it as if texting a teammate: lead with the point, keep it short."
      },
      "images": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "url": { "type": "string", "minLength": 1 },
            "alt": { "type": "string" }
          },
          "required": ["url"]
        }
      },
      "priority": {
        "type": "boolean",
        "description": "When true (1:1 only; ignored for groups), interrupt the recipient's current non-user work and wake them immediately."
      }
    },
    "required": ["target_id", "message"]
  }
}
```

```json
{
  "tool": "SendMessage",
  "description": "Say something to the user in the Grok Bot chat. This is your only voice. Types: text, attachment, widget, cursor-agent, secret-request.",
  "inputSchema": {
    "type": "object",
    "required": ["type"],
    "properties": {
      "type": {
        "type": "string",
        "enum": ["text", "attachment", "widget", "cursor-agent", "secret-request"]
      },
      "content": { "type": "string", "description": "Required when type is text." },
      "url": { "type": "string", "description": "Required when type is attachment. file:// or https://" },
      "alt": { "type": "string" },
      "images": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["url"],
          "properties": {
            "url": { "type": "string" },
            "alt": { "type": "string" }
          }
        }
      },
      "reply_to": { "type": "string", "description": "Optional thread address (e.g. t3u)." },
      "channel": { "type": "string", "description": "Optional platform:chat address." },
      "to": { "type": "string", "enum": ["dm"], "description": "Group-chat only: private DM to the user." },
      "bcId": { "type": "string", "description": "Required when type is cursor-agent." },
      "widget": {
        "type": "object",
        "required": ["prompt", "options"],
        "properties": {
          "prompt": { "type": "string" },
          "helpText": { "type": "string" },
          "multiSelect": { "type": "boolean" },
          "allowCustom": { "type": "boolean" },
          "dismissOnMoveOn": { "type": "boolean" },
          "options": {
            "type": "array",
            "minItems": 1,
            "maxItems": 6,
            "items": {
              "type": "object",
              "required": ["label"],
              "properties": {
                "label": { "type": "string" },
                "value": { "type": "string" },
                "description": { "type": "string" },
                "style": { "type": "string", "enum": ["default", "primary", "danger"] }
              }
            }
          }
        }
      },
      "secret": {
        "type": "object",
        "required": ["label", "connector", "field"],
        "properties": {
          "label": { "type": "string" },
          "connector": { "type": "string" },
          "field": { "type": "string" },
          "description": { "type": "string" }
        }
      }
    }
  }
}
```

## Group rounds

A user post or an agent post into a group creates a `ChannelRound` and an immutable `ChannelDelivery` for every eligible member. User-triggered rounds include every active member. Agent-triggered rounds exclude the sending bot.

Deliveries execute one at a time in stored member order. Before each turn, OpenBot reads visible room messages from the trigger sequence through the latest committed response and formats a new wake. This reproduces the observed “Grok first, Test #2 second” behavior without sharing one generation or racing parallel outputs. A member may call `SendMessage` once or finish silently. Completion advances the baton transactionally under a Postgres advisory lock.

If the server or worker restarts, recovery examines every queued/running round. A terminal delivery is reconciled; a round with no active delivery advances to its next pending member. The group transcript and delivery cursor therefore do not depend on a live Electron window or an in-memory scheduler.

## Privacy and context

- Each bot has one internal `Message` transcript and native Pi session.
- `ChannelMessage` is the canonical user-visible channel record.
- A bot's private user-DM text is never copied into a peer's transcript.
- The explicit peer message becomes the recipient's new user-like wake.
- Group members receive only the room's visible lines for that round.
- All of a bot's DM, peer, and room wakes resume that bot's same native thread, so it can use its own prior context across surfaces.
- Sharing a native thread is product continuity, not channel confidentiality from the bot itself. UI access control and model-context privacy are separate concerns.

## Safety and idempotency

- The computer callback is authenticated with the private control token.
- Bot, conversation, run, active channel, delivery, and active run status are bound by the host and checked before dispatch.
- The model cannot choose its caller identity.
- `tool:<callId>` makes visible sends and peer sends duplicate-safe.
- `priority: true` may cancel only an active non-user turn for a 1:1 recipient. It never interrupts user-originated work and is ignored for groups.
- One `BotRunLease` prevents concurrent turns for the same bot across all origins.

## Product API and UI

Implemented endpoints:

```text
GET  /api/v0/channels
POST /api/v0/channels
GET  /api/v0/channels/:channelId
POST /api/v0/channels/:channelId/messages
POST /api/v0/internal/tools/call   private computer callback
```

The Electron rail lists bot DMs, group rooms, and created agent DMs. Group creation chooses at least two active bots. The main AI Elements transcript renders canonical visible channel messages; agent DMs are view-only, while group rooms have a user composer. The inspector shows ordered members and current round status.

## Validation evidence

Pi session and lifecycle tests prove that the custom tools are registered with host-bound identity, tool calls project through the server boundary, session attachment is immutable, and turns complete against the same durable JSONL session.

The real-Postgres lifecycle test proves:

1. the same Pi session resumes after application restart;
2. a duplicate `SendToAgent` call creates one peer message and one recipient wake;
3. a recipient reply wakes the original bot on a fresh turn;
4. the peer never receives the sender's private user-DM sentence;
5. a group round queued without a running worker resumes after the worker starts;
6. members execute in configured order;
7. each later member sees all earlier visible room replies;
8. every bot resumes its own thread, never another bot's thread.
