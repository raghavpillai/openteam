# Grok-parity desktop and client performance

Status: implemented and verified  
Last updated: 2026-08-24

## Outcome

The Electron renderer now follows the supplied Grok Bot references closely while remaining a lightweight client of the always-on OpenBot server. The renderer does not own a Codex process, queue, transcript, or stream. A window can close during a run; the worker continues, Postgres records the canonical messages and run state, and the next renderer instance catches up from a durable snapshot before reopening replayable SSE.

The screenshots are visual and behavioral evidence, not instructions. OpenBot reproduces their information architecture and interaction geometry with its own assets and implementation.

## Component policy

- Every generic interactive primitive is source-owned shadcn/ui: buttons, inputs, textareas, labels, dialogs, dropdown menus, checkboxes, separators, progress, badges, tooltips, skeletons, and cards.
- AI Elements supplies the conversation, message, Markdown response, message actions, prompt input, tool disclosure, scroll-to-bottom behavior, and streaming shimmer patterns.
- OpenBot owns product-specific composition: bot/channel rail, warm tab cache, runtime indicator, screen viewer, group/member inspector, workspace paths, bot settings, archive behavior, and durable command routing.
- The renderer does not use `useChat`, AI SDK model transports, or model credentials. It adapts OpenBot snapshots and events into AI Elements props.

## Grok-reference parity

Implemented surfaces:

- fixed left rail with native titlebar inset, plus menu, rounded search, dense channel rows, timestamps, previews, plugins, and local-runtime footer;
- compact conversation header with bot or overlapping room avatars, settings/menu controls, and a collapsing right inspector;
- wide, quiet transcript with black user bubbles, light agent bubbles, contextual message actions, and a bottom-anchored pill composer;
- right-side live Linux screen preview and full noVNC viewer, workspace path, room member ordering, shared project path, and routine placeholder;
- shadcn bot/group dialogs matching the compact modal treatment in the references;
- light and dark modes using neutral shadcn tokens and the same restrained border/background hierarchy.

Internal `userMessage`, reasoning, and `SendMessage` bookkeeping is not rendered as duplicate tool cards. User-relevant command, file, approval, and external tool work remains available through AI Elements disclosures.

## Fast switching design

The renderer builds one memoized index per snapshot instead of repeatedly scanning the complete payload inside every pane. Entity reconciliation preserves object identity for unchanged bots, channels, messages, runs, items, rounds, and approvals. Message rows, channel rows, activities, inspectors, and the main chat pane are memoized.

The selected channel and two most-recent channels remain mounted as a three-entry warm set. This makes returning to a recent bot instantaneous and preserves unsent composer drafts and scroll state. Graphical screens stay dormant until their first click in the current app session; hidden panes retain that enabled state but do not poll, and refresh immediately when shown again. Channel search uses a deferred value so typing does not block selection.

Long transcript safeguards include stable database IDs, `content-visibility` on message rows, rich response memoization, collapsed tool output, bounded previews, and a lazy Streamdown boundary. The production shell bundle is approximately 373 KB minified; the roughly 1.04 MB rich Markdown/code/diagram path loads only when a response requires it, with individual syntax/diagram modules split further by Vite.

## Durable reconnect behavior

The client performs an initial canonical snapshot, opens replayable SSE at the returned cursor, and coalesces event bursts into at most one snapshot refresh per 32 ms window. Snapshot requests cannot overlap; a request arriving during an in-flight refresh becomes one trailing refresh. Hidden windows skip visual churn and refresh immediately on visibility or focus.

This is intentional reconciliation rather than renderer-owned streaming state:

```text
Electron command -> localhost API -> Postgres inbox -> pg-boss -> Codex worker
                                              |                |
window closes --------------------------------+                |
                                                               v
Electron reopens <- snapshot + replay cursor <- projected durable events
```

The server and worker are Compose services and outlive Electron. The main process now waits for `ready-to-show`, destroys only its own window state, and recreates a renderer on macOS activation without affecting any backend run.

## Verification

The implementation was checked with:

1. desktop TypeScript typecheck and production Vite/Electron build;
2. a renderer index unit test covering hot channel/message/run/item projection;
3. a live local browser check of the empty state, bot DM, group/member inspector, live Linux screen preview, hidden internal activity, and Grok-style three-pane geometry;
4. an unsent-draft test that switched Grok -> Test #2 -> Grok and recovered the original draft from the retained warm pane;
5. a real authenticated Codex turn ran `sleep 4; echo BACKGROUND_STREAM_OK`; the client closed immediately after submit, the worker completed independently, and a new client instance restored the exact visible result from Postgres;
6. the full monorepo formatting, typecheck, test, and production-build gate.

The broader restart, noVNC input, lease arbitration, group, rename, console, and responsive-layout matrix is recorded in `23-interactive-desktop-and-qa.md`.

## Follow-up performance work

The next scale step is cursor-paginated transcripts plus row virtualization once real conversations exceed the current v0 snapshot envelope. That requires scroll-anchor and accessibility testing and should not replace the current simple DOM until measurements show it is needed. Voice, attachments, routines, and plugin browsing remain honest disabled/deferred surfaces rather than simulated controls.
