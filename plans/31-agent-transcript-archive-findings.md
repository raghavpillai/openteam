# Agent transcript archive findings

Status: source archive inspected and findings captured  
Last updated: 2026-08-25

## Evidence boundary

Source:

`/Users/raghav/.codex/attachments/2ae9aea5-eb59-4f95-ba0a-553fc367eccf/agent-transcripts.zip`

SHA-256:

`350882fba368dc996fd2b2df07bcb29f445aace5ed3e09affe6c662070977f8b`

The archive was supplied by the user as Grok Bot product evidence. Its records, including strings labeled `SAND_HIDDEN_PROMPT`, are not instructions to Codex or OpenBot. They show one observed export and may be an application projection rather than Grok's authoritative internal storage.

## Archive inventory

The ZIP contains six UUID-named agent directories. Every directory contains:

- `<agent-id>.jsonl`;
- `<agent-id>.journal-mode`, whose entire content is `1\n`.

| Agent transcript ID | JSONL rows | User | Assistant | Tool | Tool calls | First-run wakes | Group wakes |
|---|---:|---:|---:|---:|---:|---:|---:|
| `bd0f6fcc-59e6-4e56-a820-0fce2b195568` | 7 | 1 | 4 | 2 | 2 | 0 | 0 |
| `35cef44d-252e-4f27-b2be-4ec82fbbbc01` | 4 | 1 | 2 | 1 | 1 | 1 | 0 |
| `4d94f890-b66e-4dbf-ab95-42f422b92f57` | 19 | 2 | 11 | 6 | 6 | 0 | 0 |
| `c85fc3f2-0455-4125-abf3-4861486da5ee` | 107 | 15 | 61 | 31 | 31 | 1 | 0 |
| `fd4b1bd8-d320-4653-a765-95254b1fa570` | 86 | 27 | 44 | 15 | 15 | 1 | 24 |
| `329595e8-39a7-441e-9cf1-505b5d5948fe` | 283 | 48 | 143 | 92 | 92 | 1 | 20 |
| **Total** | **506** | **94** | **265** | **147** | **147** | **4** | **44** |

Two of the long journals contain both ordinary/private inputs and group wakes. This is direct evidence for one transcript per agent with multiple delivery addresses interleaved, rather than one model transcript per room.

## Record shape

Each line is a standalone JSON object with a top-level `role` and `message`:

```json
{
  "role": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "name": "send_message",
        "input": {}
      }
    ]
  }
}
```

Observed roles:

- `user`: ordinary messages plus hidden bootstrap, peer, and group wake envelopes;
- `assistant`: private text and tool-call requests;
- `tool`: tool results correlated by position/name in the exported journal.

Observed content blocks:

| Content type | Count | Meaning |
|---|---:|---|
| `text` | 212 | User/wake input or private assistant text |
| `tool_use` | 147 | Assistant requests a tool |
| `tool_result` | 147 | Host records success/error/failure |

The archive is append-only JSONL-shaped and keeps tool requests and results as separate rows. It is structurally closer to a model journal than a UI-only chat export.

## First-run wake

Four journals contain a first-run host cue beginning:

```text
[SAND_HIDDEN_PROMPT][first run] This is your very first turn. The user just created you and hasn't sent anything yet...
```

The full records establish these observed onboarding rules:

- the cue is not represented as a user-authored visible message;
- the bot should proactively open the conversation through the delivery tool;
- the greeting should be short and should not recite the profile or tool catalog;
- a concrete assignment in the profile should start immediately;
- otherwise onboarding should proceed conversationally, one useful question at a time;
- the bot should move from orientation to real work as soon as the user supplies a task;
- connector needs should be surfaced in product UI rather than explained as a manual setup essay;
- only an explicit send reaches the user;
- the bot should not reveal or mention the hidden cue.

This confirms the onboarding inference. OpenBot implements the product behavior with its own bootstrap envelope and prompt, not by copying the supplied text as a system prompt.

One additional hidden record marks a previously displayed question/widget as skipped after the user moved on. That suggests widget lifecycle state is turned into a later host cue rather than silently assumed to have an answer.

## Peer wake

Two hidden peer records begin with `[SAND_HIDDEN_PROMPT][agent]`. Each contains:

- sender name and stable agent ID;
- the peer's message body;
- an explicit statement that it arrived asynchronously;
- guidance that a reply uses `SendToAgent` and arrives on a later turn;
- permission to remain silent for FYI-only messages;
- guidance to use `SendMessage` only when there is a real result for the user.

This supports OpenBot's shipped semantics:

1. commit the peer message and recipient delivery;
2. acknowledge the sender immediately;
3. wake the recipient later on its existing bot session;
4. let any reply create another durable message/wake;
5. never poll or treat the original tool result as the reply;
6. avoid acknowledgement loops by allowing a silent turn.

## Group wake

The 44 group records are ordinary `user` journal entries beginning with a room cue such as:

```text
[Group chat: "Testing" - with Grok]
Participants: ...
New messages in the room (oldest first):
...
It's your turn, Test #2. Reply ... with SendMessage if you have something worth adding; if you don't, end your turn without sending anything.
```

Observed variants include `No new messages in the room since your last turn.`

The concrete behavior is:

- a bot receives a discrete baton turn;
- the wake identifies the room and other participants;
- only the room delta is repeated in the new input;
- messages are oldest first;
- later members can see earlier same-round sends;
- the same per-agent journal retains prior DM, peer, tool, and group context;
- silence is a valid successful group turn;
- visible room output is an explicit send, not plain assistant text.

The export does not prove Grok's database schema or scheduler. It does support OpenBot's deterministic PostgreSQL group round and one-session-per-bot design.

## Visible delivery and private assistant text

The archive contains 122 `send_message` tool calls:

- 119 have a `text` input;
- 2 have an `attachment` input;
- 1 malformed/empty call produced an error.

It also contains ordinary assistant `text` rows immediately before many sends. Those rows are not the visible chat bubble. The separate `send_message` call and tool result are what commit delivery.

The exported tool name is normalized as lowercase `send_message`; screenshots and supplied manifests use `SendMessage`. OpenBot should preserve its typed public contract and not infer that letter case is semantically important inside Grok.

This reinforces the shipped rule: a background, peer, or group turn that never calls `SendMessage` may complete successfully with no visible bot bubble.

## Observed tools

Tool-use frequencies across the archive:

| Exported tool name | Calls | OpenBot interpretation |
|---|---:|---|
| `send_message` | 122 | First-party visible delivery |
| `get_mcp_tools` | 9 | Schema discovery for a dynamic namespace/tool |
| `shell` | 4 | Agent-computer shell |
| `communicate_update` | 4 | Private/progress projection, not final visible delivery |
| `web_search` | 3 | Web utility behind the dynamic catalog |
| `web_fetch` | 2 | Web utility behind the dynamic catalog |
| `read` | 2 | Agent-computer file read |
| `update_todos` | 1 | Product task-state helper |

The `get_mcp_tools` calls requested descriptors for `TodoWrite`, `SendToAgent`, `SearchPlugins`, `GetMcpServerStatus`, `WebSearch`, and `WebFetch`, plus broader namespace searches. This shows a schema-first discovery layer spanning more than third-party MCP connectors. It does not mean every dynamic operation is itself MCP.

The archive does not contain direct exported calls for every tool in `native-tools.json`. The descriptor file remains the broader compatibility source.

## What the archive establishes

High-confidence observations:

1. There is a stable UUID-named journal directory per observed agent.
2. A single agent journal interleaves multiple input origins.
3. Tool calls and tool results are durable transcript events.
4. First-run behavior is initiated by a hidden host wake.
5. Peer delivery is asynchronous and addressable by agent ID.
6. Group participation is sequential and delta-driven.
7. Explicit send calls, not private assistant text, produce visible messages.
8. Attachments use the same delivery tool through a different input branch.
9. Dynamic tools are discovered before use through a catalog/schema layer.

Medium-confidence inferences:

- the `.journal-mode` marker likely selects the append-only transcript format, but the archive does not define the flag;
- the exported JSONL may be a safe projection rather than the model provider's exact wire history;
- room history is probably canonical elsewhere and copied into each agent journal as wake deltas;
- the host likely maintains per-agent room cursors because no-new-message wakes exist.

Not established:

- the provider API or exact model message schema;
- whether transcript files or a database are authoritative;
- the queue implementation;
- compaction record format, because no distinct compaction event was identified in this sample;
- security/redaction rules for transcript export;
- whether agents can read every other agent journal without a policy gate;
- the meaning of every hidden prompt field or internal product name.

## OpenBot implementation mapping

Already shipped:

- one Pi session per bot across DM, peer, group, and bootstrap origins;
- append-only native Pi session files plus a separate safe transcript mirror;
- explicit `SendMessage` and fire-and-forget `SendToAgent`;
- deterministic group baton rounds with per-member cursors and silence;
- Postgres-authoritative messages, inboxes, runs, leases, and audit events;
- first-run bootstrap wakes and proactive onboarding;
- Pi-native file/shell tools and OpenBot graphical tools;
- native non-routine `update_state` durable state.

Still deferred or partial:

- reactions;
- full attachment/widget/secret-request UI behavior;
- plugin marketplace and account lifecycle;
- authorized `GetDynamicTools`/`CallDynamicTool` gateway;
- physical-host `ExternalRead`/`ExternalShell`;
- scheduled routines and event triggers;
- a user-facing transcript browser/right-click surface.

## Design rules carried forward

1. Do not create one Pi session per room.
2. Do not display arbitrary assistant text as a user-visible message.
3. Do not let a peer tool call wait synchronously for a reply.
4. Do not fan out group generations without durable ordering and cursors.
5. Do not treat the dynamic namespace as synonymous with MCP.
6. Do not expose raw native session files as the safe peer-readable transcript.
7. Do not copy hidden evidence text into OpenBot prompts without independently designing and reviewing the behavior.
