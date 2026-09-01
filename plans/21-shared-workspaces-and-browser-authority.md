# Shared workspaces and browser authority

Status: implemented; live validation recorded during the v0 acceptance pass  
Last updated: 2026-09-01

> Runtime update: every reference below to a durable Codex thread now maps to the bot's durable Pi session. Filesystem, group cwd, screen, and BrowserBroker semantics are unchanged. See `27-pi-agent-runtime.md`.

## Outcome

OpenBot now matches the useful workspace semantics inferred from the supplied Grok screenshots without pretending folders or screens are security boundaries:

- one installation owns one persistent Linux computer;
- every bot has one durable Pi session and one default working folder;
- every group owns one durable shared project folder;
- all bots can see the full `/workspace` tree;
- every bot has a separate XFCE display and Chromium UI;
- browser identity and durable profile state belong to the computer while each bot keeps a separate safe Chromium process and UI.

This is why multiple bots can have different screens and Chrome windows yet immediately see the same files. Screens are views into one computer, not containers with separate filesystems.

## Filesystem layout

```text
/workspace
├── bots
│   ├── researcher-<id>/       default DM cwd for Researcher
│   └── builder-<id>/          default DM cwd for Builder
├── projects
│   └── project-falcon-<id>/   cwd for every Project Falcon group turn
└── shared/                    explicit cross-bot handoffs
```

`Bot.defaultDirectory` remains the bot's DM/default cwd. `Channel.workingDirectory` persists the project folder for group channels. Creation uses server-generated slugs plus stable ID suffixes, and the private computer gateway validates every requested path against `/workspace` before creating it.

The worker selects cwd by origin:

- group wake with a project folder → the group's `workingDirectory`;
- user DM, direct agent wake, and other turns → the bot's `defaultDirectory`.

Pi still resumes the same bot session. Switching cwd for a group turn does not fork context or fabricate a new messages array. The group wake also includes the project path, and platform instructions list the bot folder, shared handoff folder, and every joined group's folder.

The Electron inspector calls these paths **Working folder** and **Shared project folder**. It explicitly says the full workspace is shared so users do not mistake organizational folders for access control.

## Separate browser UIs, computer-scoped profile authority

Pointing multiple live Chromium processes at one writable profile is unsafe because Chromium uses process-singleton locks and assumes one profile owner. OpenBot therefore keeps:

```text
/home/openbot/.openbot/chromium/<botId>/
```

for each bot. The browser windows, history, tabs, downloads, local storage, and settings are independent. Each process receives a unique loopback-only remote-debugging port derived from its stable screen slot.

`BrowserBroker` is the encrypted live authority for origin state:

1. discover the bot Chromium browser through its loopback DevTools endpoint;
2. reconcile cookies, local storage, IndexedDB, Cache Storage, and service-worker registrations;
3. propagate additions, changes, and deletions to attached pages for the same origin;
4. preserve structured-clone IndexedDB values, including binary/blob/container types;
5. persist durable cookies and origin state in one AES-256-GCM encrypted authority file;
6. retain session cookies in memory while the computer service is alive;
7. reconcile one final time before a browser or screen is destroyed or recreated.

`BrowserProfileAuthority` covers the profile databases that Chromium cannot safely share live. After a browser stops, it atomically publishes Session Storage, settings, bookmarks, history, session tabs, extensions and extension state, saved-password/Web Data databases, and related portable state. Before another bot browser starts, that stopped-profile snapshot is hydrated into its separate profile. A pre-authority profile may seed an empty authority once, but a dormant stale profile cannot replace an existing snapshot merely by launching. Linux client certificates already live at the shared computer-user NSS path (`~/.pki/nssdb`). Chrome uses a deterministic computer-local password backend so copied login databases remain decryptable by the other bot profiles.

Agent page control is separately scoped: `BrowserUseSession` leases only pages it creates, assigns stable `viewId` values, follows owned popups, and never adopts unrelated human or bot tabs. Browser-level CDP storage and target-management commands remain denied to model-issued calls; only the trusted broker can route them.

Neither DevTools ports nor the encryption key are exposed through Compose. GUI child environments remove the control token, database URL, and OpenAI API key. The encrypted jar and key remain inside the private `openbot_computer_home` volume and are included in coordinated backups.

## Concurrency semantics

Origin state synchronizes live across attached pages. Native Chromium profile databases use stopped-profile publication because copying LevelDB/profile files while two Chromium owners are writing them can corrupt both profiles. A browser that is already running receives live origin state immediately; native settings, extensions, password databases, and restored tabs are applied on its next browser launch. If two running profiles change the same native preference, the last safely stopped browser becomes the next published snapshot.

## Persistence and recovery

The database migration adds nullable `Channel.workingDirectory` and backfills existing groups under `/workspace/projects/group-<id>`. On server boot, OpenBot creates the standard roots and all active group directories through the private path-contained computer API.

The following remain one coordinated recovery set:

- Postgres records and group directory pointers;
- shared workspace volume;
- Pi session tree in the computer-home volume;
- computer home, including browser profiles, encrypted live authority, stopped-profile authority, and the shared NSS certificate store.

Restoring only one store can produce a valid-looking UI with missing context, files, or browser state and must not be presented as a successful recovery.

## Acceptance results

The 2026-08-24 live Compose pass verified:

1. Creating a group returned and created `/workspace/projects/workspace-acceptance-<id>`.
2. Alpha and Beta retained different real runtime identities during the original validation; the current Pi runtime preserves the same invariant with distinct Pi session IDs while every group command runs from that exact shared project directory.
3. Alpha created `alpha.txt`; Beta saw it and added `beta.txt`; the final room response reported both files.
4. DM turns continued to use each bot's own default folder, and the integration test now asserts both DM and group cwd routing.
5. Chromium ran on separate displays, profile paths, and loopback DevTools ports.
6. A cookie written through Alpha appeared in Beta after reconciliation.
7. Deleting that cookie through Beta removed it from Alpha and the authority.
8. After restarting the computer service, a fresh Gamma profile received a durable cookie restored from the encrypted authority.
9. Authority files were mode `0600`, plaintext probes were absent, and cleanup left zero test cookies.
10. Compose health and the full repository check remained green after the implementation.

The 2026-09-01 expansion added focused coverage for all live origin-state families, stopped-profile publish/hydrate, explicit bot-owned tab routing, and coordinated backup of the encrypted authority, native authority, and NSS database.
