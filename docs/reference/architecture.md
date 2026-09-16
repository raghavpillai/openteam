# Architecture

OpenTeam runs a server, PostgreSQL database, worker, and Linux computer in Docker Compose on one
host. The desktop and mobile apps connect to that server. Model credentials stay in the computer
container, separate from bot processes and client apps.

## From a message to a bot's reply

```text
 Desktop app · iPhone app        chat, live screens, settings
          │  HTTP(S) + event stream
          ▼
       server ────────── PostgreSQL    bots, chat history, job queue
          │  durable wake job
          ▼
       worker                          one turn at a time per bot
          │  private token
          ▼
      computer                         Linux desktop + Pi runtime
          ├── /workspace               shared files for every bot
          ├── one screen per bot       live view over noVNC
          └── model credentials        private to the runtime
```

1. The app posts your message to the **server**, which writes it to **PostgreSQL** and queues a
   durable wake job.
2. The **worker** claims the bot's turn. Each bot runs one turn at a time; other wakes wait in
   its mailbox. Different bots can work concurrently.
3. The **computer** reopens the bot's saved session and runs the model through
   [Pi](https://github.com/earendil-works/pi), the embedded agent runtime. Tools run on the
   Linux computer: shell commands, file operations, browser and desktop input, and packaged
   MCP plugins. Remote and desktop plugins use their configured connections.
4. Events stream back through the worker into PostgreSQL. The server pushes them to connected
   apps, and configured mobile push notifications can alert you when you are away.

Server-side turns and schedules continue when a client closes, as long as the host and Docker
keep running. The OpenTeam desktop app supplies the approval bridge for launching delegated
tasks, including computer-use workers, and accessing the physical host. Keep that app running
when work needs the bridge.

## The bot computer

The shared computer is a Debian environment with XFCE, Chromium, a file manager, and a terminal.
Each bot has its own 1280×800 screen and browser profile, so logins persist and bots can use
separate desktops concurrently.

The apps show live screens over noVNC. Use pause or takeover before interacting with a screen
an agent is using, then return control when you finish. A bot can hand over a step that needs
your involvement, such as a login, 2FA, CAPTCHA, or payment, or ask a yes/no question.

Every bot, room, routine, and subagent starts in `/workspace`. Files written by one are visible
to the others immediately. Separate screens and browser profiles do not give bots separate
filesystems.

## Conversations, memory, and teamwork

- **Bots** have one ongoing conversation that resumes after restarts. Dated Markdown memory
  exists in three scopes: per bot, shared across all bots, and per project. You can edit it by hand.
- **Rooms** include you and up to six bots, replying in ordered rounds. Bots can also message
  each other directly and create teammates.
- **Subagents** handle delegated work: plain execution, computer use, browser use, or video review.
- **Routines** save instructions with up to eight schedules using cron, intervals, or presets.
  They run with the bot's context and keep a run history. Event routines require a configured
  [event subscription](../reference/automation-event-subscriptions.md).
- **Skills and plugins** add reusable instructions and tools. Shared `SKILL.md` files are
  available across bots; plugin skills and connections have their own bot grants. Tool policies
  allow, ask before, or deny a call. See [plugins and skills](../usage/plugins.md).

See [settings](../configuration/server.md) for the editable files, runtime settings, and environment variables.

## Tools and runtime behavior

Built-in tools include `SendToUser`, `ReactToMessage`, `RecallMemory`, `ListSections`,
`update_state`, `Shell`, `Read`, and `Screenshot`. `GetDynamicTools` and `CallDynamicTool` expose
additional capabilities, including computer use, messaging other bots, subagents, and plugins.
Bot state and tool names use OpenTeam's portable layout so files stay readable across hosts.

The runtime also supports shell completion waits, memory recall, binary host transfers, web
search and fetch, reviewed forms and external drafts, and bot template sharing. Further details:

- [Platform prompt and tools](../reference/platform-system-prompt.md): behavior, configuration, and verification limits.
- [Web search](../configuration/web-search.md): Exa, Tavily, Brave, and Bing via SerpApi.
- [Native capabilities](../reference/native-capabilities.md): host access and file transfers.
- [Memory](../reference/memory-parity.md) and [compaction](../reference/compaction.md): keeping context across turns.

## Credentials and persistent data

The model runtime holds provider credentials inside the computer container's private volume.
Bot shells run as a different user and cannot read them; client apps do not receive them.
Provider and model changes apply to new turns without a restart. See
[provider setup](../configuration/models.md#connect-a-provider) for authentication options.

State is stored in six Docker volumes:

| Store | Contents |
| --- | --- |
| PostgreSQL | Bots, chat history, runs, mailboxes, job queue, and plugin state |
| Computer home | Pi sessions, provider credentials, screen mappings, and browser profiles |
| Agent data | Bot profiles, memory, routines, skills, and transcripts |
| Assets | Uploaded and generated attachments |
| Workspace | Shared files under `/workspace` |
| Snapshot store | Snapshot blobs and their manifest |

Restarting the stack preserves this data. Back up and restore all six stores together.
`openteam update` takes a database dump before applying the release and rolls back on failure;
that dump does not replace a full backup. See [backups and restore](../manage/backups.md#what-to-keep).
