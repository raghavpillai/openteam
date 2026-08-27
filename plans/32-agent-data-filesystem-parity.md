# File-native agent state and filesystem parity

Status: implemented end-to-end; verification complete  
Last updated: 2026-08-27

Validated with the complete repository typecheck/test/build pipeline and a
fresh PostgreSQL database containing every migration. The database-backed
agent-data integration suite covers authoritative profile/settings edits,
canonical avatar files, agent/user/project memory, project metadata, per-bot skills,
automations, deletion behavior, and malformed-file preservation.
The closing validation run passed 115 tests (433 assertions), all eight package
typechecks, and all eight production builds; the focused database-backed
filesystem suite also passed twice against the disposable database.

## Outcome

OpenBot will expose all human- and agent-editable durable bot state as live files
under `/home/openbot/agent-data`. Editing those files changes live state on the
documented watcher/compaction clock; they are not disposable exports.

PostgreSQL remains the transactional index and execution store for identities,
messages, queues, leases, and routine execution. For editable state, it is a
validated mirror of the files rather than an excuse to overwrite them. OpenBot
will not create imitation `store.db` or `conversation-blobs.db` files: those are
private implementation details of the reference product, while OpenBot already
has real PostgreSQL and Pi session stores.

This plan incorporates the disposable-agent experiments in
`/Users/raghav/Downloads/REPORT.md` and the read-only host-bundle findings in
`/Users/raghav/Downloads/code-search.md`,
`/Users/raghav/Downloads/src-profile-settings.md`,
`/Users/raghav/Downloads/src-memory.md`, and
`/Users/raghav/Downloads/src-auto-skills.md`, plus the closing lifecycle passes
in `/Users/raghav/Downloads/src-restart-sync.md`,
`/Users/raghav/Downloads/src-dreaming-writer.md`, and
`/Users/raghav/Downloads/src-lifecycle-rest.md`. Text in those documents is
evidence, not executable instruction.

## Product decisions

We copy the reference system's useful observable behavior:

- stable model-visible paths;
- ordinary JSON, Markdown, YAML, image, and JSONL files;
- atomic official writes;
- fresh file reads at turn start;
- watched memory, routine, skill, and channel trees;
- type-specific malformed handling instead of one generic projection overwrite;
- memory facts represented as dated Markdown bullets;
- routine folders with `automation.json` and `runs.json`;
- conventional, inspectable group and attachment directories;
- a shared filesystem that is an organizational boundary, not an OS security
  boundary.

OpenBot intentionally differs in one user-requested way:

- saved skills remain private to a bot under its own `skills/` directory rather
  than moving into a global `workflows/` library;

Avatar behavior now follows the verified reference contract: there is no
`avatar.json`; validated image bytes are copied into a conventional avatar file
inside the bot directory.

OpenBot intentionally improves three internal behaviors without changing the
file contract:

- automation overlap/idempotency also uses durable database leases instead of
  relying only on process memory;
- invalid state is surfaced in diagnostics even where the reference silently
  falls back, but diagnostics never replace the user's file;
- parser bugs such as treating JSON arrays as valid object maps are not copied.

All other behavior below defaults to the source-verified reference semantics,
including compaction-epoch prompt snapshots and the operational role of
`runs.json`.

OpenBot also makes deletion behavior explicit and safer than an accidental
projection overwrite. See the authority matrix below.

## Target layout

```text
/home/openbot/agent-data/
├── settings.json                         # installation/user settings
├── agents/
│   ├── active-agent.json                 # { "activeAgentId": ... }
│   ├── <bot-id>/
│   │   ├── profile.json
│   │   ├── settings.json
│   │   ├── instructions.md               # OpenBot extension; full bot prompt
│   │   ├── avatar.<png|jpg|jpeg|webp|gif|svg> # optional canonical image bytes
│   │   ├── projects.json                 # { "projects": [<slug>, ...] }
│   │   ├── memory/
│   │   │   ├── profile.md
│   │   │   ├── log/<YYYY-MM>.md
│   │   │   └── .dreaming/
│   │   │       ├── evidence/
│   │   │       ├── explicit/
│   │   │       ├── synthesized/
│   │   │       ├── tombstones/
│   │   │       └── next-refresh-at
│   │   ├── skills/<skill-slug>/
│   │   │   ├── SKILL.md
│   │   │   └── ... helper files
│   │   ├── automations/<routine-slug>/
│   │   │   ├── automation.json
│   │   │   └── runs.json
│   │   ├── attachments/
│   │   ├── channels/<platform>/connection.json
│   │   └── audit.jsonl
│   └── <group-id>/
│       ├── group.json
│       ├── profile.json
│       └── settings.json
├── user-memory/by-agent/<writer-bot-id>/
│   ├── profile.md
│   └── log/<YYYY-MM>.md
├── projects/<project-slug>/
│   ├── project.md
│   └── memory/by-agent/<writer-bot-id>/
│       ├── profile.md
│       └── log/<YYYY-MM>.md
├── agent-transcripts/<bot-id>/<bot-id>.jsonl
└── .openbot/                             # non-prompt internal indexes only
```

No `notes.md` is generated. A note is a normal fact line whose content begins
with `[note] `. Episodes use `[episode] `.

## Lifecycle

### Creation

A newly created bot gets only the files needed to represent its initial editable
state:

- `profile.json`;
- per-agent `settings.json`;
- `instructions.md` when non-empty;
- a conventional avatar image only when one has been installed.

The reference product also creates an internal `store.db`; OpenBot does not fake
one. Memory, skill, automation, attachment, channel, audit, and dreaming paths
are created lazily.

### First wake

Before prompt assembly OpenBot:

1. performs a scoped safety scan of the bot, user-memory shards, and joined
   project-memory shards;
2. regenerates a missing or syntactically unparseable `profile.json` from the
   last-known database name/description, and creates a missing `settings.json`
   with `notifyOnAgentUpdates: true`;
3. imports valid changed files into transactional indexes and records bounded
   diagnostics for fallback/coercion behavior;
4. creates empty `memory/`, `memory/log/`, `skills/`, and `automations/`
   directories;
5. resolves profile and memory prompt snapshots for the current compaction epoch.

`attachments/`, `audit.jsonl`, automation `runs.json`, and `.dreaming/` appear
only when first used.

### Later changes

- Agent, API, and UI mutations use the same file-state service.
- The worker watches profile/settings for roster refresh and watches memory,
  skills, automations, channels, user memory, and project memory with a 50 ms
  debounce.
- Watch events are hints. Startup scans, turn-start scans, and a periodic repair
  scan guarantee convergence when events are coalesced or lost.
- Profile and settings files are read on session open/list and turn setup; no
  correctness depends on watcher delivery. Profile/memory prompt sections remain
  frozen within a compaction epoch as specified below.

## Authority and deletion matrix

| Artifact                  | File behavior                                                                                             | Database behavior                                     | Missing file or folder                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `profile.json`            | Authoritative when JSON is an object; known fields coerce individually and official writes whitelist keys | UI/index mirror plus compaction-epoch prompt snapshot | Missing or syntactically invalid is regenerated on session open; parseable bad fields fall back without rewrite                |
| per-agent `settings.json` | Known booleans default independently; valid unknown keys survive merge writes                             | UI/index mirror                                       | Missing is created with notifications true; malformed-but-present stays and reads as defaults until the next write replaces it |
| `instructions.md`         | Authoritative text                                                                                        | Indexed on successful parse/read                      | Missing means empty instructions                                                                                               |
| `avatar.<type>`           | Authoritative image bytes; realpath must remain inside the agent directory                                   | Indexed canonical path                                | Missing means no custom avatar                                                                                                 |
| `projects.json`           | Authoritative joined project slug list after safe-ID validation                                           | Membership/delivery index                             | Missing means no file-declared memberships; missing project dirs are pruned                                                    |
| memory document           | Raw Markdown is authoritative; recognized single-line facts are indexed and normalized                    | Search index plus compaction-epoch prompt snapshot    | Deleting a document removes its facts; deletion alone creates no tombstones                                                    |
| skill folder              | `SKILL.md` and helper files are authoritative                                                             | Catalog/index only                                    | Deleting the folder deletes that bot's saved skill                                                                             |
| routine folder            | `automation.json` is authoritative configuration                                                          | Scheduler/index and execution state                   | Deleting folder pauses and soft-deletes the routine; it is not regenerated                                                     |
| `runs.json`               | Capped disk-backed run ledger, reread on every routine-store operation                                    | Durable leases additionally prevent OpenBot overlap   | Missing means no recorded runs and can permit event redelivery; it does not reset `lastRunAt`                                  |
| global settings           | Whole-file schema: one invalid field rejects the entire loaded object                                     | In-memory UI settings mirror                          | Missing/invalid loads defaults without rewrite; next successful persist writes a whitelist                                     |
| group/channel files       | Files represent editable name, settings, and membership                                                   | Membership delivery remains transactional             | Invalid member profile is a group error; missing group config does not silently delete a room                                  |
| transcript/audit files    | Append-only readable projections                                                                          | Message/event stores are authoritative                | May be rebuilt where source events still exist                                                                                 |

This matrix replaces the current generic rule that every missing generated file
is recreated from PostgreSQL.

## Write and reconciliation protocol

### Official writer

Every `update_state`, API, and UI change follows one service path:

1. validate the exact target and acquire a target-scoped PostgreSQL advisory
   lock;
2. read and parse the current file so partial updates preserve fields they do
   not own;
3. produce the complete new document;
4. write a same-directory temporary file, flush the file, rename it atomically,
   and flush the directory where supported;
5. update the database index and append an event containing the path and content
   digest;
6. let the watcher/scan replay the file idempotently if the database update fails
   after the rename.

Temporary names follow predictable non-colliding patterns and are ignored by
watchers. No official writer edits a live JSON/Markdown file in place.

### Hand-edit importer

- Imports are keyed by canonical relative path and SHA-256 content digest.
- Digests, last successful parse, warnings, and generation are stored outside
  prompt-visible directories under `.openbot/` or in an equivalent database
  table. The current per-directory `.openbot-projection.json` sidecars are
  retired.
- Import is idempotent and serialized by the same target lock as official writes.
- A changed file is read after debounce and must have a stable stat/digest across
  the read. Type-specific fallback rules apply: malformed profile is regenerated
  on open, malformed per-agent settings/global settings read as defaults, invalid
  memory lines are skipped, and invalid automation/skill records are ignored.
- No importer follows symlinks in agent state trees. Avatar installation and
  serving additionally verify that the canonical realpath remains inside the
  bot directory.
- A successful import does not rewrite the source merely to normalize formatting.

### Conflict rule

The final successful atomic rename wins. An official partial update first reads
the current disk document and merges fields it does not own. The event log records
the prior and new digest so races are diagnosable. There is no silent three-way
merge of two conflicting values.

### Restart and synchronization authority

An ordinary OpenBot server, worker, computer, or Compose restart reopens the
existing PostgreSQL database and durable volumes. It does not hydrate an older
remote copy first. Offline edits in `openbot_agent_data` therefore survive and
are imported by startup or turn-start reconciliation. PostgreSQL prompt
snapshots preserve the current compaction epoch across restarts.

The reference product's content-addressed box-store manifest, etag CAS, explicit
`--box-copy-in` hydrate mode, and SQLite `VACUUM INTO` snapshots are transport
details for its cloud box architecture. OpenBot has no implicit copy-in mode and
does not emulate those files. A backup restore is an explicit administrative
operation over PostgreSQL plus all durable volumes as one recovery set; only
that operation may replace local state with restored bytes.

## File contracts

### `profile.json`

```json
{
  "name": "Research Bot",
  "description": "Tracks and explains the project.",
  "title": "Researcher",
  "avatarShape": "●",
  "avatarColor": "#4f7cff",
  "namedBy": "user"
}
```

Known string fields coerce independently to empty/default values. `namedBy` is
kept only for `user|app`. Unknown keys survive a hand edit until any official
profile write, which serializes a whitelist. Missing, unreadable, JSON-syntax
invalid, null, or primitive content is regenerated on session open from the
last-known database name/description; a parseable object with bad fields is not
healed. Unlike the reference's JavaScript parser accident, arrays are rejected.
OpenBot's emoji-like `avatarShape` and hex color remain its own visual contract.
Operational status does not belong in this file.

### Per-agent `settings.json`

```json
{
  "notifyOnAgentUpdates": true,
  "hiddenFromSidebar": false
}
```

Read defaults are notifications true and hidden false. A missing file is created
on list/open with only `notifyOnAgentUpdates: true`. An official partial update
merges into a valid existing object and preserves unknown keys. Malformed-but-
present JSON is left untouched and reads as defaults; the next official write
starts from `{}` and therefore discards the malformed content/extras.

### Root `settings.json`

Version 1 initially covers OpenBot settings that already exist in the desktop
client or runtime: user timezone, notification preferences, pinned agent IDs,
sidebar sections, theme/language preference, and settings migrations. Parsing is
all-or-nothing: a wrong required field makes the whole in-memory value fall back
to defaults without rewriting disk. A later successful persist writes only the
known schema and drops unknown or previously invalid content. `pinnedAgentIds`
remains optional so absent means never written while `[]` means explicitly
cleared; missing `sidebarSections` is exposed to the client as `[]`. Account
credentials, tokens, OAuth state, and connector secrets never enter this file.
The desktop UI must stop keeping overlapping durable preferences only in
`localStorage` once the file-backed API lands.

### `agents/active-agent.json`

The only field is `activeAgentId`. Missing or malformed content means no
persisted selection; session startup chooses the first openable agent (or creates
a fallback), then rewrites the one-key file atomically. It does not synchronize
with pinned IDs or sidebar sections.

### Avatar file

At most one conventional `avatar.png`, `avatar.jpg`, `avatar.jpeg`,
`avatar.webp`, `avatar.gif`, or `avatar.svg` is canonical; PNG wins if multiple
files are present, followed by that extension order. Agent installation accepts
an absolute source path only after both its lexical and real path remain inside
that bot's directory. It reads and sniffs at most 5 MiB, removes prior
conventional files, and atomically copies the bytes to `avatar.<detected-type>`.
The source may then be deleted. Clearing the avatar removes all conventional
files. Symlink escapes and unsupported or empty content are rejected.

### Memory

The recognized line grammar is:

```text
^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$
```

Examples:

```md
- (2026-08-27) The weekly report uses net revenue.
- (2026-08-27) [note] Follow up after the release.
- (2026-08-27) [episode] We chose the file-native state model.
```

Rules:

- whitespace in fact content collapses to one space and the entire content,
  including `[note] ` or `[episode] `, is clamped to 500 characters;
- dates round-trip as UTC midnight and log month buckets use UTC;
- headings, comments, prose, malformed bullets, indented/multiline continuations,
  and other Markdown are preserved but not injected as facts;
- `[note] ` and `[episode] ` remain part of the stored content. Their recall
  importance is respectively 0.5 and 1.5 versus 1 for an ordinary fact;
- logical ID is `sha1(lowercase(normalized-content))[0:16]`;
- duplicate lines remain on disk but share one logical ID. Official add refuses a
  duplicate across profile and log; official remove deletes the first matching
  occurrence;
- `update_state write` appends a line atomically to the correct writer shard;
- `update_state forget` removes matching recognized occurrences from that scope
  under the same lock. It must include the `[note] ` or `[episode] ` prefix when
  that prefix is part of the recorded text;
- global user memory is a merged namespace backed by independent
  `user-memory/by-agent/<writer-id>` shards, avoiding cross-bot file-write races;
- project memory uses the same writer-shard rule;
- user/project shards do not use dreaming metadata or cross-agent tombstones;
- shard merge visits writer IDs lexicographically, deduplicates case-insensitively,
  keeps the strictly newer UTC date, and on a same-day tie keeps the earlier
  writer ID;
- prompt concatenation is user memory, then up to three project blocks, then own
  agent memory. Instructional precedence is the reverse: own > project > user;
- facts, notes, episodes, tombstones, and origin markers have no TTL. Recency is
  ranking, not deletion.

The database index must retain source path, line occurrence/order, UTC date,
logical content ID, and prefix-bearing content. Raw duplicate occurrences remain
addressable even though recall and cross-shard merge deduplicate them logically.
The current `MemoryFact` uniqueness on `(namespace, factHash)` is insufficient
because it loses writer shard, source location, order, and deletion semantics.

Reference-compatible prompt limits are: own profile 100; own recent 30/4,000
characters; merged user profile 50/4,000 and recent 15/2,000; each project profile
25/2,500 and recent 10/1,500; at most three project blocks. Ranking is
`log2(importance) + createdAt/(30 days)` with recency/order tie-breakers.
Before a cross-shard merge, each user shard is already limited to 100 profile/15
recent and each project shard to 100 profile/10 recent. Projects with facts sort
before empty projects, then newest fact, then slug; only the first three receive
full fact blocks.

### Dreaming and episode modes

Only the bot's own memory root has `.dreaming/`; user and project shards do not.
Empty marker files are authoritative metadata:

- `explicit/<id>.memory` marks an explicit fact;
- `synthesized/<id>.memory` marks a synthesized fact;
- `tombstones/<id>.deleted` blocks synthesis recreation until an explicit write
  revives it;
- `next-refresh-at` is decimal epoch milliseconds plus newline and schedules a
  24-hour temporal review.

Explicit forget/clear creates tombstones only when dreaming is enabled. Deleting
Markdown directly creates no tombstone. Synthesis removal clears origin markers
but does not tombstone. Tombstones have no TTL.

The shipped reference has a strict reader/deleter for recovery entries shaped as
`{id, occurredAt, user, assistant}` under `evidence/<uuid>.json`, but no shipped
writer. Normal turn evidence therefore remains in RAM and is lost on a host
crash. Each side is bounded to 8,000 characters and live RAM keeps the newest 12
entries per agent for at most 64 agents. OpenBot matches that disk behavior; it
does not invent a durable spool writer.

When dreaming is enabled, every non-hidden turn with non-empty user text records
evidence, clears `episodePending`, and bypasses explicit extraction/episodes.
When disabled, memorable exchanges run extraction and every six pending turns
may append one `[episode]` log fact. Dreaming synthesis itself produces only
profile/log facts, never note/episode prefixes.

### Skills

Path identity is `<bot>/skills/<kebab-slug>/SKILL.md`; slug maximum is 48. Skill
frontmatter supports `name` (80), `description` (1536), optional trigger/metadata,
and preserves unrecognized Cursor-compatible keys. Body maximum is 100,000
characters; prompt injection clamps each body to 8,000 and the catalog to a
global budget.

The folder slug is the stable file identity. `id` in frontmatter is optional and
not required for parity. Helper files remain untouched. The current requirement
that every description literally starts with "use this when" is removed; a clear
selection description remains required. Official creation resolves collisions as
`slug`, `slug-2` … `slug-999`, then a timestamp fallback; changing the skill name
does not rename its folder. Delete recursively unlinks the bot-owned folder.

Disk changes are immediately readable. A 50 ms trailing watcher debounce updates
the UI, while the model-facing catalog is frozen with conversation context and
refreshes on summary/compaction. A newly written skill may therefore be invoked
directly by its known path before it appears in the catalog. Parse caching keys on
inode, nanosecond mtime, and size and avoids caching files newer than two seconds.

For a bot, override priority is bot-owned skill ID > managed skill ID > plugin
skill ID/name slug. Managed and plugin records remain global read-only inputs;
only the bot-owned library is private. A create request containing a schedule
trigger creates a cron automation instead of storing a triggered `SKILL.md`.

### Automations

`automation.json` accepts the reference-compatible fields:

- `name`, `prompt`;
- legacy `schedule` or structured `trigger`;
- `triggerPresentation` version 1;
- `enabled` (default true for a hand-written config);
- `provenance: "user" | "untrusted"`;
- `createdAt`, `lastRunAt` in epoch milliseconds;
- `pendingNotices`, `raisedNotices`.

Missing `enabled` defaults true. Missing/unknown provenance becomes `untrusted`.
`createdAt` is clamped to no later than file birth/mtime; `lastRunAt` is nullable
and anchors the next fire as `lastRunAt ?? createdAt`. Cron-only configs serialize
top-level `schedule` and omit `trigger`; non-cron/group configs serialize
`trigger`, while a group containing cron also carries its first schedule.

The trigger union is cron, Slack, GitHub, Origin, Microsoft Teams, Linear, Sentry,
PagerDuty, webhook, or a group of at most eight listeners. Origin cannot be mixed
with Teams, Linear, Sentry, PagerDuty, or webhook. The five-minute automation
floor is a feature gate and defaults off for parity; enabling it rewrites/clamps
short schedules and raises the compatible notice. Untrusted enabling still goes
through confirmation and spend-guard policy.

Folders use a collision-safe kebab slug with the same `-2` … `-999` scheme as
skills. Every sibling directory reserves its slug even when its JSON is invalid.
Changing `name` never renames the folder. Delete recursively unlinks it with no
tombstone and makes the slug immediately reusable.

`runs.json` is a pretty JSON array capped to the 20 newest `startedAt` records. A
record has required `id` and `startedAt`, optional `requestId`, trigger kind,
nullable `finishedAt`, `ok|error|running` status, 300-character detail, optional
`errorKind`/event, and at most 25 coalesced run IDs. It is reread on every store
operation and is operational for run-ID idempotency, completion matching, UI last
run, and spend-guard counts. Deleting it does not reset cron scheduling because
that uses `automation.json:lastRunAt`, but it can allow an event/cloud fire to be
redelivered. OpenBot preserves these semantics while additionally using durable
database leases so a process restart cannot create overlap merely because the
reference relied on RAM.

## Prompt assembly

Prompt construction resolves one compaction epoch, defined as the count of
conversation summary archives:

1. profile and instructions;
2. effective settings;
3. global user memory;
4. joined project memory;
5. own agent memory;
6. scheduled routines;
7. the bot's saved-skill catalog and selected skill bodies.

Profile and memory prompt snapshots are real consistency boundaries, stored in
OpenBot's database rather than imitation agent SQLite:

- a profile snapshot freezes the full profile section and identities until the
  epoch advances; a mid-epoch name/description change is delivered as a turn
  announcement and updates only the announced identity;
- a memory snapshot freezes the already-budgeted user/project/own render until
  the epoch advances;
- empty memory does not mint a snapshot. The first fact-bearing turn therefore
  reads live files and then freezes that render;
- summary/compaction increments the epoch; the following turn refreshes both;
- malformed snapshot rows are discarded and rebuilt from the live/fallback
  sources;
- skill catalog context follows the same documented summary-refresh boundary,
  although skill files remain immediately readable and directly invocable.

Token limits are deterministic and tested. Content excluded by limits is reported
by counts rather than silently presented as complete. UI roster watchers remain
live even while model prompt sections are frozen.

## Groups, attachments, audit, and transcripts

- Group folders use `group.json` version 1 with unique member IDs and an explicit
  cap. Group delivery and history remain database-backed.
- Incoming attachments are copied or linked into the receiving bot's
  `attachments/` directory with sanitized collision-safe names. Any manifest is
  internal; the files themselves are directly usable by the bot.
- Agent actions append JSONL audit envelopes. Shell commands are recorded
  verbatim, so permissions and the prompt must warn against putting secrets on a
  command line. Audit writes never block the requested action if forwarding is
  unavailable.
- Peer transcript JSONL remains a redacted, rebuildable projection. Raw model
  session blobs and credentials are never exposed in agent-data.

## Security and operational boundaries

- Agent-data root mode is `0700`; ordinary agent directories are `0755` and
  readable files `0644` because all bots intentionally share one computer UID.
- Every dynamic path segment is checked against traversal, NUL, `.`/`..`, and
  separator attacks.
- Import walks use `lstat`, reject symlinks and special files, cap file counts and
  bytes, and never descend into temporary/corrupt quarantine paths.
- JSON/YAML/Markdown parsing is size-bounded. Local SVG avatars are allowed, but
  the avatar endpoint applies no-execute and sandbox response headers.
- `settings.json` never stores connector secrets, auth tokens, encryption keys,
  or approval credentials.
- Files and folders are namespaces, not authorization boundaries; prompts and UI
  make cross-bot editing policy explicit.

## Migration from the current implementation

1. Stop periodic canonical rewrites and retain a backup of the agent-data volume.
2. Import every current `.openbot-projection.json` generation once, recording
   malformed/unreconciled edits before removing sidecars.
3. Move root `user-memory/{profile,notes,log}` content into writer shards. Convert
   recognized `notes.md` facts to `[note] ` lines without discarding surrounding
   Markdown.
4. Give every saved skill a stable per-bot slug and migrate UUID-named folders.
5. Migrate routine UUID folders to collision-safe slugs and emit the expanded
   compatible config plus `runs.json` from execution history.
6. Migrate legacy database or `avatar.json` pointers once by copying validated
   bytes into a conventional avatar file, then remove the pointer.
7. Add `instructions.md` from each bot's existing database field.
8. Build the source-aware memory/file-state indexes and verify a dry-run report
   before applying deletions or moves.
9. Add profile/memory prompt-snapshot rows keyed by compaction epoch; do not
   expose snapshot render text in agent-data.
10. Retain a versioned migration marker and a recoverable legacy backup until the
    new acceptance suite passes on the running stack.

Migration code must be idempotent and must not infer deletion merely because an
old projection was never generated.

## Implementation phases

### Phase 0 — freeze the contract

- Treat the completed source pass as the reference baseline and record the three
  non-blocking uncertainties below.
- Add TypeScript schemas/parsers and golden fixtures for every file.
- Add the authority/deletion matrix to user-facing documentation.

### Phase 1 — file-state engine

- Replace generic projection reconciliation with typed document handlers.
- Add external file-state generations/digests and target-scoped locks.
- Add atomic fsync-and-rename helpers, stable-read checks, watchers, startup
  scans, turn-start scans, and periodic repair scans.
- Stop rewriting unchanged or merely differently formatted valid files.

### Phase 2 — profile, settings, instructions, and avatar

- Route bot creation, UpdateAgent, `update_state`, and desktop UI through the same
  file-first service.
- Add root settings and active-agent APIs, then migrate overlapping desktop
  `localStorage` preferences.
- Implement canonical avatar-byte installation, in-directory realpath checks,
  format sniffing, legacy pointer migration, and deletion behavior.

### Phase 3 — memory namespaces

- Introduce the source-aware memory index and writer-sharded user/project memory.
- Implement exact normalization, logical IDs, importance ranking, append, forget,
  duplicate handling, deletion, shard merge, and prompt limits.
- Implement agent-only `.dreaming` origin/tombstone and RAM evidence state plus the
  non-dreaming six-turn episode path.

### Phase 4 — per-bot skills

- Move to slug folders and a lossless YAML parser.
- Preserve helper files and extra frontmatter.
- Implement watched create/edit/delete and deterministic catalog budgets.

### Phase 5 — automations

- Expand config parsing to schedule/trigger/provenance/notices.
- Add slug identity, watched create/edit/delete, operational `runs.json`,
  confirmation gates, durable overlap leases, and crash-safe synchronization.

### Phase 6 — groups, attachments, audit, and operational polish

- Add group/channel projections and on-demand attachment materialization.
- Add action-audit JSONL and redacted transcript parity.
- Complete migration, backup/restore, repair, and user documentation.

## Verification matrix

Every file handler receives the same test matrix:

- initial creation and lazy first-wake tree;
- valid edit, formatting-only edit, and unknown keys/frontmatter;
- missing optional and required fields;
- wrong types and malformed partial writes;
- deletion, rename, read-only file, directory-in-place-of-file, symlink, FIFO,
  oversized file, and path traversal;
- agent/API/UI write racing a manual atomic rename;
- watcher delivery, lost watcher event, startup recovery, and turn-start recovery;
- process termination before rename, after rename/before database commit, and
  after database commit;
- two bots writing global user memory concurrently;
- backup/restore with pending unreconciled edits;
- same-epoch profile announcement, memory freeze, first-fact behavior, and
  post-compaction snapshot refresh;
- skill disk/UI immediacy versus model-catalog summary refresh;
- `runs.json` deletion/redelivery and durable overlap behavior.

Required automated layers:

1. parser/serializer golden tests;
2. property tests for round-trip and arbitrary unknown data preservation;
3. database integration tests for idempotency and migrations;
4. watcher/concurrency tests on the mounted filesystem;
5. server/worker tests for all official write paths;
6. container end-to-end tests that edit files from the computer container and
   observe UI, prompt, routine, and memory effects;
7. recovery tests with deliberately killed worker processes and restored volume
   snapshots.

## Acceptance criteria

- A valid manual edit reaches its documented clock without restart: roster/UI
  after watcher debounce, operational automation state immediately, and frozen
  profile/memory/skill prompt sections after summary/compaction.
- Type-specific malformed behavior matches the contract: profile regeneration,
  settings defaults, invalid memory-line omission, and ignored invalid routines.
- Official writes are atomic, lossless for fields they do not own, and converge
  after a simulated crash.
- Global user memory merges per-writer shards without lost updates.
- Duplicate raw facts survive on disk while logical recall deduplicates by the
  source-verified ID; prefixes, dates, order, and source shards survive indexing.
- Skill and routine folder creation, edits, name-without-folder-rename, and deletion have documented,
  tested effects.
- Avatar bytes are copied into the agent directory, survive source deletion, and
  cannot be installed or served through a realpath escape.
- The desktop, API, and worker observe live file state while the bot prompt
  intentionally observes the recorded compaction epoch plus identity announcements.
- No fake internal database files, secrets, raw private prompts, or unredacted
  model-session blobs appear in agent-data.
- A coordinated backup restores files, indexes, routine state, attachments, and
  visible history without a newer valid file being overwritten by stale data.

## Non-blocking source uncertainties

The source pass is complete enough to implement. The remaining uncertainties do
not change the file contract:

1. The reference's five-minute automation floor is default-off but its live
   remote flag was not inspected. OpenBot exposes the same default-off local gate.
2. Cloud-side webhook POST retry/dedup beyond the host's run UUID and poll/ack
   behavior was not visible in the shipped host bundle.
3. A narrow reference compaction failure window remains uncertain if blob
   persistence throws midway through a parallel write.
