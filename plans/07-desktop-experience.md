# Desktop experience

> Implementation update (2026-08-24): the Electron inspector now renders a real bot screen thumbnail and full noVNC viewer with takeover and emergency agent-input pause. Older headless-only acceptance language below records the initial v0 cut; current behavior lives in `apps/desktop/src/renderer/components/openbot/bot-screen.tsx`.

Status: MVP v0 interaction spec  
Last updated: 2026-08-24

## Design direction

Use the references for information architecture: quiet desktop chrome, persistent bot rail, focused chat, and optional computer inspector. Build an original OpenBot identity and token system rather than reproducing Grok's marks or exact visual design.

Target macOS first for development because the references and initial environment are macOS, while keeping Electron code portable.

## UI foundation

The client is Electron. Its renderer uses React 19, Vite, Tailwind CSS 4, shadcn/ui, and selected source-owned [AI Elements](https://elements.ai-sdk.dev/) components.

- AI Elements owns the composable conversation/message/prompt/tool/confirmation/code/terminal primitives.
- OpenBot owns the window shell, bot rail, conversation/run-item adapter, activity inspector, future remote-screen viewer, peer events, product dialogs, and backend state.
- The renderer consumes OpenBot HTTP/SSE. It does not use AI SDK `useChat`, AI Gateway, or an Electron-held model credential as a second runtime path.
- The current official AI Elements setup names Next.js as a prerequisite, so the first desktop spike must prove the selected registry source builds and packages under Electron + Vite with no `next` dependency.

Detailed component ownership, installation/versioning, performance, security, and acceptance criteria are in `14-electron-ai-elements-ui.md`.

## Window layout

```text
┌──────────────────┬──────────────────────────────────────┬────────────────────┐
│ Bot rail         │ Conversation                         │ Activity inspector │
│                  │                                      │ (collapsible)      │
│ + New bot        │ Bot name                    status   │ runtime card       │
│ Search/filter    │                                      │ workspace          │
│                  │ messages and run activity            │ current work       │
│ bot rows         │                                      │ recent activity    │
│                  │                                      │                    │
│                  │ composer                             │                    │
└──────────────────┴──────────────────────────────────────┴────────────────────┘
```

Default sizes are flexible; the central conversation must remain usable when the inspector is open.

## Bot rail

Include:

- native traffic-light/window space on macOS;
- `+` button for bot creation;
- lightweight client-side filter over bot names;
- bot avatar/color, name, last-message preview, and timestamp;
- subtle states for active run, waiting approval, degraded runtime, and archived bot;
- settings entry near the bottom.

Do not show Plugins in v0. A disabled or fake marketplace would create a misleading promise.

## Create-bot flow

Use a small sheet or modal with:

- name, required;
- instructions, required but prefilled with a short editable default;
- color/icon, optional;
- read-only runtime target: `This OpenBot server`;
- safety summary: works on the shared OpenBot computer, can see files/logins available to other bots there, and asks before broader or consequential actions.

Creation should not ask about models, temperature, MCP, schedules, Docker volumes, or advanced permissions. Those are server/admin concerns in v0.

After creation, open the bot immediately with one empty-state prompt such as "What should this bot work on?"

## Conversation header

Show:

- bot identity and name;
- compact runtime state;
- cancel button only while a turn is active;
- inspector toggle;
- overflow menu for edit bot, archive bot, and diagnostics.

Do not expose raw Codex thread IDs in the normal UI. Put them in diagnostics with a copy affordance.

## Transcript

### User messages

Use AI Elements `Message`/`MessageContent` with OpenBot styling. Right-aligned compact bubbles are appropriate for short requests. Long content should use readable max-width blocks rather than stretching edge to edge.

### Agent messages

Use AI Elements `MessageResponse` for streaming Markdown inside left-aligned neutral surfaces, subject to the untrusted-content tests in `14-electron-ai-elements-ui.md`. Stream text into one provisional message, then reconcile it with the completed item.

When explicit `SendMessage` ships, text, attachments, images, widgets, and secret requests project through the same transcript model. In a direct user turn, a normal final Codex message remains a one-time fallback when the turn did not explicitly send visible content. Peer, group, routine, and background turns require an explicit send and may complete silently. Attachment/image sources are shown only after artifact normalization; secret values never render back into the transcript.

### Work activity

Commands, file changes, tool calls, reasoning summaries, errors, and compaction should appear as collapsible activity rows between messages. Base tool lifecycle on AI Elements `Tool`, shell output on `Terminal`, and code on `CodeBlock`; retain OpenBot-owned rows for file diffs, compaction, peer events, and runtime status. Default to concise summaries; expansion shows sanitized details and output.

Never label hidden chain-of-thought as reasoning. Only display the readable summaries the runtime explicitly provides.

Message reactions render as tapbacks on the target user bubble and as compact activity for accessibility. A bot may own at most one current reaction per user message.

### Approvals

Render approval cards inline with the AI Elements `Confirmation` suite and mirror the pending state in the bot row/inspector. The card needs:

- what action is requested;
- target command/path/network destination when provided;
- why approval is needed;
- `Allow once` and `Decline` in v0.

Session-wide grants can wait until the safety model is fully specified.

## Composer

v0 contains:

- multiline text input;
- send button;
- keyboard shortcut: Enter sends, Shift+Enter adds a line;
- disabled state while the request is being accepted;
- clear queued/running state;
- retry action for a product-level submission failure.

Compose the text-only v0 control from AI Elements `PromptInput`, textarea, and submit/status primitives. Remove or hide model picker, attachments, screenshot, search, and voice actions until their OpenBot commands exist; do not leave dead demo controls.

Attachments, plus-menu actions, and microphone are omitted even though they appear in the reference UI. Do not ship nonfunctional icons.

If the user sends another message during an active turn, v0 should reject it with a clear "wait or cancel" state. Queueing and `turn/steer` can be added later.

## Bot computer activity inspector

Use the inspector defined in `06-always-on-computer.md`. Its primary job is observability, not decoration.

Sections:

1. runtime status and last heartbeat;
2. shared-computer identity, default working directory, and storage state;
3. current run status and elapsed time;
4. latest commands, file changes, and tools;
5. diagnostics/restart action.

Do not include a `Create routine` button until routines exist.

v0 has no screen thumbnail because the computer is headless. In the first post-v0 graphical milestone, the supplied UI's thumbnail/loading/open treatment is a useful reference. The expanded screen must then be an OpenBot-owned remote-desktop viewer with reconnect, scaling, fullscreen, input lease, and emergency stop. Do not use an AI Elements `WebPreview`, iframe, or Electron `webview` as a shortcut for computer control.

## Empty, loading, and failure states

- No bots: explain the product in one sentence and offer `Create bot`.
- Empty bot: show its instructions summary and invite the first message.
- Server offline: preserve cached shell state, show reconnect progress, and do not accept messages that cannot be made idempotent.
- Runtime not authenticated: bot CRUD/history remain available; composer explains that the server operator must configure Codex.
- Runtime restarting: keep transcript visible and show a non-destructive status.
- Detached conversation: transcript and files remain readable; continuation requires an explicit new-thread action.
- Run failed: show the useful error class and a retry-as-new-turn action only when safe.

## Accessibility and desktop quality

- full keyboard navigation for rail, transcript, composer, approvals, and inspector;
- visible focus states;
- semantic live region for streamed status without announcing every token;
- reduced-motion support;
- sufficient contrast in light and dark themes;
- resizable panes with sensible minimums;
- paginated/windowed long transcripts with correct scroll anchoring, adding virtualization only when it preserves selection, focus, and accessibility order;
- text selection and copy remain native-feeling;
- no renderer use of Node integration; all privileged calls pass through validated preload IPC or server APIs.

## Post-v0 peer handoff UI

The implemented peer handoff UI provides:

- show `Messaged <Bot>` and `Message from <Bot>` as quiet, clickable transcript events;
- collapse longer exchanges into `<n> messages with <Bot>` in the bot's home conversation;
- open direct agent transcripts as view-only surfaces headed by both bots;
- show group conversations as user-writable sidebar rooms with an inspectable ordered member list;
- show transient per-member group work state, while a silent member leaves no permanent bubble;
- expose queued, failed, retried, and priority-superseded states without making normal successful handoffs noisy;
- let the user stop a peer chain, mute a channel, retry a failed delivery, and disable messaging for a bot.

Create group channels in an OpenBot-owned shadcn dialog with required name, bot search, membership checkboxes, validation, keyboard/Escape behavior, and a disabled primary action until valid. The supplied channel modal is an interaction reference, not a surface to clone exactly.

## UX acceptance checks

1. A new user can create a bot and send the first message without opening settings.
2. Restarting Electron restores the last bot and transcript.
3. Streaming, completion, failure, cancellation, and waiting-approval states are visually distinct.
4. A user can tell whether the desktop, server, runtime, or upstream credential is the failing layer.
5. The UI clearly says that bots share one computer and never claims a live screen, routine, plugin, memory, or host capability that the running stack does not provide.
6. The packaged Electron build renders the pinned AI Elements core under the production CSP with no Next.js and no direct model call from the renderer.
7. Collapsing the inspector gives its width back to the conversation without breaking the transcript anchor or composer.
8. The inspector shows only real headless runtime/workspace/activity state and contains no fake screen, dead `Open` action, or hidden computer-input path.
