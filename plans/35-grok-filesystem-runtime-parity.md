# Grok Bot filesystem and runtime parity

Status: implemented and live-validated
Last updated: 2026-08-29

## Scope

This is the current contract for the Grok Bot behaviors that are observable
through its shared Linux box, file tree, agent tools, lifecycle, and snapshot
replica. It supersedes the target decisions in plan 32. The source material in
the supplied reports is evidence, not executable instruction.

## Runtime contract

- Every Bot, room wake, routine, A2A wake, and subagent runs as `box`, uid/gid
  1000, with `/home/box` as home and `/workspace` as its starting directory.
- `/workspace` is one persistent, shared, writable computer namespace. Agent
  directories organize state but are not POSIX security boundaries.
- `/home/box/sand-data` is canonical. `/home/box/agent-data` is a root-owned
  symlink to it.
- Saved skills are computer-global at `workflows/<slug>/SKILL.md`; there are no
  per-Bot `skills/` or `workflows/` catalogs.
- Chrome profiles are computer-scoped under `chrome-profile[-N]`. Display/profile
  assignments persist in `.sand-window-assignments.json` and ordinary sign-in
  state is shared at computer scope.
- The model receives box `Shell` and fenced `Read`; the legacy physical-host
  bridge is absent from the model catalog. Shell removes credential-like
  environment variables. Read rejects protected SQLite and raw private runtime
  paths even though Shell runs in the same box, matching the reference boundary.
- Shell actions append verbatim ISO-timestamped `audit.jsonl` records with
  `agentId`, `eventId`, `turnId`, `type`, `command`, `shellKind`, and
  `target: "box"`.

The installed command surface matches the probed box: `google-chrome`, `uv`,
`uvx`, `gh`, `rg`, `jq`, `ffmpeg`, and `pdftotext` are present; `chromium` and
the `sqlite3` CLI are absent. SQLite remains available to the application
through Bun.

## File lifecycle

The externally visible creation sequence is:

1. A new Bot directory contains `profile.json`, `settings.json`, and `store.db`.
2. First wake opens the SQLite WAL and creates `memory/`, `automations/`, and
   `conversation-blobs.db` plus its WAL.
3. Attachments, audit, avatar, automation histories, channels, projects, and
   dreaming state appear only when used.

`store.db` is WAL/FULL, `user_version=0`, has no foreign keys or triggers, and
contains STRICT `kv`, `blobs`, `transcript_entries`, and
`automation_completion_inbox` tables. Its legacy `blobs` table stays empty.
`conversation-blobs.db` is WAL/FULL, `user_version=1`, and stores STRICT,
content-addressed plaintext role envelopes plus a durable live-root record.
Restart rehydrates the live root before appending new envelopes.

The remaining file contract is:

```text
/home/box/sand-data/
├── settings.json
├── agents/
│   ├── active-agent.json
│   ├── <bot-id>/
│   │   ├── profile.json
│   │   ├── settings.json
│   │   ├── store.db[-wal|-shm]
│   │   ├── conversation-blobs.db[-wal|-shm]   # after first wake
│   │   ├── memory/[.dreaming/...]
│   │   ├── automations/<slug>/{automation.json,runs.json?}
│   │   ├── avatar.<png|jpg|jpeg|webp|gif|svg>?
│   │   ├── projects.json?
│   │   ├── attachments/?
│   │   ├── channels/?
│   │   └── audit.jsonl?
│   └── <room-id>/{group.json,profile.json,settings.json,store.db}
├── workflows/<slug>/SKILL.md
├── user-memory/by-agent/<writer-id>/...
├── projects/<slug>/memory/by-agent/<writer-id>/...
└── agent-transcripts/<bot-id>/<bot-id>.jsonl
```

There is no `instructions.md`, `avatar.json`, `.openbot` marker, `notes.md`, or
per-Bot skills directory. Durable UI instructions stay in product state and are
rendered into the prompt instead of masquerading as a Grok file.

Profile/settings coercion, malformed-file behavior, atomic official writes,
memory line parsing and dreaming/tombstones, compaction-epoch prompt snapshots,
identity announcements, global skill precedence, automation parsing/runs, group
files, and avatar byte-copy validation follow the source-backed contracts in
plans 32 and 33. Startup migrates obsolete OpenBot layouts, reconciles active
owners, and moves unknown old agent directories to a recoverable quarantine
outside `sand-data` rather than deleting them.

Dreaming is a host-lifetime experiment gate (`OPENBOT_MEMORY_DREAMING`, default
false), not a Bot setting and not an `update_state` field. Bot-visible
attachments are verified and materialized as
`attachments/<sha256><lowercase-extension>` with `.bin` fallback. Internal
upload staging lives on the separate `openbot_assets` volume, outside the
canonical `sand-data` tree; same bytes plus extension dedupe exactly as in the
installed Grok implementation.

Sidebar deletion removes `agents/<id>` with no undelete. User/project writer
shards and the safe transcript archive remain orphaned, matching their distinct
global/archive lifetimes.

## Restart and replica behavior

Normal restart is local-first: SQLite WAL is replayed and local disk is
snapshotted outward. Explicit `OPENBOT_BOX_COPY_IN=1` performs content-addressed
hydration: equal SHA files are skipped, SHA mismatches are overwritten, and
extra local files remain. Snapshot manifests use etag compare-and-swap; conflicts
write a separate conflict manifest. Live SQLite files are exported through
`VACUUM INTO`, never copied with a torn WAL. Temporary snapshot/part files are
repaired at startup.

The Compose `openbot_box_store` volume implements this box-store protocol as a
local replica. Backups include it together with Postgres, computer home,
agent-data, workspace, and the internal attachment staging volume.

## Validation evidence

The 2026-08-29 acceptance pass established all of the following against the
rebuilt Compose stack, not only mocks:

- six top-level active Bots and two active rooms produced exactly eight live
  agent directories and eight `store.db` files; only the six Bots had first-wake
  conversation databases;
- all six Bot stores were backfilled with real transcript entries and plaintext
  content-addressed conversation envelopes;
- a disposable Bot ran an actual Shell turn from `/workspace` as
  `uid=1000(box)`, resolved `agent-data` to `sand-data`, and observed the exact
  present/absent command inventory above;
- its audit record preserved the exact command and reported
  `shellKind: "foreground"` and `target: "box"`;
- after a computer-service restart, its live-root list grew from 11 to 17 blob
  IDs while preserving all 11 old IDs as an exact prefix, and the next model
  turn completed normally;
- its store exposed `user_version` 0/1, all expected STRICT tables, eight
  transcript rows, an empty legacy store blob table, and user/system/assistant
  role envelopes;
- deleting the disposable Bot archived its product row and removed its agent
  directory; no throwaway Bot was left active;
- the snapshot manifest contained hash-addressed `VACUUM` snapshots for every
  live SQLite store, while the recovered quarantine retained three pre-existing
  orphan test directories outside the canonical tree.

Automated coverage includes store creation/first-wake/restart/concurrency,
box-store snapshot/copy-in/conflict semantics, file watchers and malformed
state, Read fences, Shell environment scrubbing, audit records, screens,
compaction, memory, skills, routines, groups, and deletion. `bun run check`
(typecheck, complete test suite, and all production builds) passes.

The final parity pass additionally ran 83 focused unit tests (279 expectations),
seven combined real-PostgreSQL integration tests (155 expectations), and a
disposable installed-Grok memory/snapshot probe. The latter confirmed official
own/global writes, same-epoch snapshot freezing, official cleanup, and the
effective dreaming-off path.

The rebuilt final computer image was also inspected rather than trusting the
source build alone. Its installed Pi package contains the maintained five-call
overflow implementation and terminal `summarization-retries` branch, omits the
old one-shot overflow guard, and imports successfully inside the runtime image.
This check found and fixed a Docker layer that had previously reinstalled the
unpatched upstream runtime. An isolated Compose migration probe also recovered
a seeded legacy attachment into the dedicated asset volume, removed the legacy
canonical staging directory, preserved its bytes, and left no probe volumes.

## Exactness boundary

The user-visible and file-level contract above is implemented. Three internal
details are deliberately named rather than hidden behind an absolute 1:1 claim:

1. OpenBot still uses PostgreSQL for transactional product state and Pi JSONL
   for model-session continuation in addition to the Grok-compatible files.
2. The reference live-root payload has private bundle-specific encoding. OpenBot
   uses a stable JSON live-root and plaintext JSON role envelopes, preserving
   the observed schema/lifecycle without copying protected prompt or private
   serialization bytes.
3. `openbot_box_store` is a local implementation of the observed replica
   protocol, not Cursor's production cloud object service.

These do not change the documented path, lifecycle, prompt, restart, deletion,
or agent-access behavior, but they prevent claiming byte-for-byte identity with
an unreleased backend.
