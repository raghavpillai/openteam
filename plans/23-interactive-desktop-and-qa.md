# Interactive desktop and full v0 QA

Status: implemented and live-validated  
Last updated: 2026-08-24

## Outcome

Clicking a bot's screen preview now opens its 1280×800 XFCE desktop and immediately acquires the renewable human input lease. The noVNC canvas accepts real mouse and keyboard input in-place, matching the supplied Grok Bot interaction model: the preview is a small live window into the bot's graphical computer, and opening it makes that computer directly usable without a second “Take control” click.

The desktop remains a lightweight client surface. Closing the overlay, switching bots, unmounting the screen component, or closing the whole renderer sends a best-effort lease release. Closing the app does not own or cancel the underlying agent run.

## Interaction contract

- Preview click opens noVNC and requests human control in the same explicit user action.
- The viewer reports `Acquiring input control…` until the server confirms the lease.
- `Controlling` means mouse and keyboard input are routed to the selected bot display and model-driven `Computer` input is rejected.
- `Pause agent` is an independent emergency gate for graphical agent actions.
- Closing the overlay explicitly releases control; `pagehide` and component cleanup use a keepalive request as the crash/close fallback.
- The 45-second lease continues to renew only while the viewer is open.
- Chromium, Thunar, and Terminal launchers remain available in the viewer header.

## Live QA matrix

The following checks ran against the real Compose services, Postgres, pg-boss, Codex app-server, Electron renderer code through the local web surface, and the real noVNC/XFCE display.

| Area | Validation | Result |
| --- | --- | --- |
| Human desktop input | Clicked the terminal through noVNC, sent individual keyboard events for `id`, and pressed Enter | Terminal returned `uid=10001(openbot) gid=10001(openbot) groups=10001(openbot)` |
| Native GUI apps | Opened Chromium, Thunar, and Terminal from the viewer controls | All rendered on the selected bot's display |
| Immediate takeover | Clicked the inspector preview and waited for viewer state | Viewer entered `Controlling` without a second control action |
| Agent/human arbitration | Asked a live bot to call `Computer` while human takeover was active | Tool failed with `The user currently holds the graphical input lease` |
| Lease recovery | Closed the viewer, then repeated the model `Computer` call | Tool completed successfully |
| Window-close cleanup | Acquired takeover, closed the entire client tab, and read screen status | `humanTakeover` returned to `false` |
| Pause/resume | Toggled the viewer controls and read screen status | `agentInputPaused` changed `false -> true -> false` |
| Background durability | Started `sleep 4; echo BACKGROUND_STREAM_OK`, closed the client immediately, and reopened it | Run completed in the worker and the durable result appeared after reopen |
| Server restart | Restarted the server with a client open | Health returned ready; the existing transcript remained visible; no client warning/error logs |
| Computer restart | Restarted the graphical-computer service and reopened the preview | Desktop returned to `Controlling` and preserved its bot display/profile state |
| Group creation | Selected two bots and created a room | Room created without React recursion or hydration errors |
| Group round | Asked both members for an ordinal reply | Member 1 and member 2 each ran once in order and the round completed |
| Rename consistency | Renamed a bot after it joined DM and group surfaces | Bot record, DM rail/header, inspector, and group sender label updated consistently |
| Fast switching | Repeatedly switched between a DM and group while retaining warm panes | No loading blank, crash, or lost draft; automation round-trip stayed tightly bounded |
| Window sizes | Inspected 980×640 and 1440×920 layouts | All three panes and composer remained usable without overlap |
| Console | Repeated the final flows in a fresh client | No new warning or error logs |

## Bugs surfaced and fixed

### Nested interactive controls crashed group creation

The group member row rendered a Radix checkbox button inside a shadcn button. That invalid button nesting triggered hydration warnings and a `Maximum update depth exceeded` crash when a member was selected. The row is now a neutral container with a labeled checkbox, preserving full label hit area without nested interactive elements.

### Bot rename left the direct channel stale

Updating a bot changed the `Bot` record but not its durable `bot_dm` channel name, so the settings inspector showed the new name while the rail and header showed the old one. The server now updates the bot and its direct channel in one transaction before emitting `bot.updated`.

### Nested Codex sandbox failed inside the computer container

Codex's workspace sandbox tried to create an unprivileged namespace inside the already restricted `no-new-privileges` container and ordinary shell calls failed in `bwrap`. OpenBot now requests `danger-full-access` from the inner Codex session for both thread start and resume. This does not grant host access: Docker remains the actual isolation boundary and still supplies the non-root user, volume scope, capabilities, network, and host-mount policy. A protocol regression test covers both start and resume.

### Compose commands assumed the Docker CLI plugin

The host used for the live pass exposes the standalone `docker-compose` command but not `docker compose`, so the documented one-command startup and package scripts were not portable to it. `scripts/compose.sh` now selects the available Compose v2 frontend and is used by the package scripts, README, and backup flow.

### A late inspector poll could recreate an archived screen

Archiving stopped a screen and released its slot, but a status request that had already passed the server's active-bot check could arrive immediately afterward and provision the same bot again. `ScreenBroker` now tombstones destroyed bot IDs for the computer process lifetime, aborts in-progress desktop startup at every asynchronous boundary, waits for that startup to settle, and only then removes the session and slot. A focused lifecycle test proves a late status call cannot recreate a destroyed screen. The live cleanup finished with an empty slot registry and no remaining Xvfb/x11vnc processes.

## Remaining production limits

The v0 viewer is loopback-only and suitable for a local self-hosted deployment. Remote hosting still needs authenticated viewer URLs, TLS for the websockify path, per-installation authorization, rate/resource limits, and a production review of Chromium's container sandbox posture. The 980×640 minimum is functional but intentionally dense with both side panels open; either inspector can be collapsed for a larger transcript.

The macOS DMG/ZIP package builds successfully, but it is intentionally unsigned in this development environment and still uses Electron's default application icon. Signing/notarization and final product icon assets remain release-engineering work. The AI Elements Markdown/diagram path also remains a large but lazy-loaded chunk; it does not enter the lightweight chat shell until rich content requires it.
