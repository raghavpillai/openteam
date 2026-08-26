# Shared workspaces and browser authority

Status: implemented; live validation recorded during the v0 acceptance pass  
Last updated: 2026-08-25

> Runtime update: every reference below to a durable Codex thread now maps to the bot's durable Pi session. Filesystem, group cwd, screen, and BrowserBroker semantics are unchanged. See `27-pi-agent-runtime.md`.

## Outcome

OpenBot now matches the useful workspace semantics inferred from the supplied Grok screenshots without pretending folders or screens are security boundaries:

- one installation owns one persistent Linux computer;
- every bot has one durable Pi session and one default working folder;
- every group owns one durable shared project folder;
- all bots can see the full `/workspace` tree;
- every bot has a separate XFCE display and Chromium UI;
- ordinary browser sign-in cookies belong to the computer and synchronize across those separate Chromium processes.

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

## Separate browser UIs, shared sessions

Pointing multiple live Chromium processes at one writable profile is unsafe because Chromium uses process-singleton locks and assumes one profile owner. OpenBot therefore keeps:

```text
/home/openbot/.openbot/chromium/<botId>/
```

for each bot. The browser windows, history, tabs, downloads, local storage, and settings are independent. Each process receives a unique loopback-only remote-debugging port derived from its stable screen slot.

`BrowserBroker` is the computer-scoped authority for cookies:

1. discover the bot Chromium browser through its loopback DevTools endpoint;
2. read its current cookie set;
3. merge newly observed cookies into the computer jar;
4. propagate additions, changes, and deletions to every attached bot browser;
5. persist only durable cookies in an AES-256-GCM encrypted file;
6. retain session cookies in memory while the computer service is alive;
7. reconcile one final time before a screen is destroyed or recreated.

Neither DevTools ports nor the encryption key are exposed through Compose. GUI child environments remove the control token, database URL, and OpenAI API key. The encrypted jar and key remain inside the private `openbot_computer_home` volume and are included in coordinated backups.

## Deliberate limits

The browser broker synchronizes cookies, not arbitrary profile databases. It does not yet copy:

- local storage or IndexedDB;
- service-worker caches;
- extensions and extension state;
- saved passwords, passkeys, or client certificates;
- browser preferences, bookmarks, or open tabs.

Most cookie-based sessions should carry across bot screens. Sites that bind login to another browser store may require per-bot authentication until a narrowly scoped adapter exists. OpenBot must not claim full browser-profile parity for those sites.

## Persistence and recovery

The database migration adds nullable `Channel.workingDirectory` and backfills existing groups under `/workspace/projects/group-<id>`. On server boot, OpenBot creates the standard roots and all active group directories through the private path-contained computer API.

The following remain one coordinated recovery set:

- Postgres records and group directory pointers;
- shared workspace volume;
- Pi session tree in the computer-home volume;
- computer home, including browser profiles and encrypted cookie authority.

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
