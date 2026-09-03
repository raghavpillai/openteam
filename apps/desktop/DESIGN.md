# Desktop design system

The desktop renderer is built on one small design system. Everything visual should be
expressed through these tokens and primitives rather than ad-hoc hex values or one-off
components.

## Voice

A calm, paper-like workspace where each bot is a colleague with its own room. Copy is plain,
specific, and says what happens next.

- Sentence case everywhere except proper nouns. Product nouns (bot, group, routine, plugin,
  server, provider, model) are lowercase mid-sentence.
- Buttons are verbs: "Create bot", "Send", "Take control", "Retry setup".
- Helper text answers "what does this do / what happens next" in one sentence. Never expose
  runtime jargon ("Pi", "durable", "wake", "lease", "projection", "runtime", "inference").
- Errors say what failed and what to do: "Couldn't save. Your draft is still here."
- One status vocabulary, from `components/openteam/status.tsx`: Working (green), Needs you
  (amber), Starting (accent), Setup failed (red), Idle (gray).

Glossary: bot · group (several bots in one chat) · bot-to-bot chat (read only) · routine (runs on
a schedule) · background task (a bot's helper) · screen (the bot's Linux desktop: "Open screen",
"Take control", "Hand back") · plugin (tools and accounts) · provider / model / reasoning effort ·
server (the self-hosted stack) · this computer (the machine running the app).

## Type

Fonts are vendored under `src/renderer/fonts` (latin subsets, OFL) and declared in `styles.css`.

- UI and body: Plex Sans (`font-sans`), 400/500/600. Base 13.5px for UI, 14.5px/22px for chat.
- Display: Instrument Serif (`font-display`), only for large moments: sign-in hero, empty-state
  titles, dialog and settings page titles. Always 400 weight.
- Mono: Plex Mono (`font-mono`) for timestamps, IDs, cron, versions, tool names, keyboard hints,
  and the `microlabel` utility (11px, uppercase, tracked, ink-3).

## Color

Tokens live in `styles.css` under `:root` and `:root[data-theme="dark"]`, and are exposed to
Tailwind through `@theme inline`.

| Token | Tailwind | Use |
| --- | --- | --- |
| `--bg` | `bg-paper` | app background behind panes |
| `--surface` | `bg-surface` | chat pane, dialog bodies |
| `--raised` | `bg-raised` | cards, popovers, selected sidebar row |
| `--sidebar`, `--inspector` | `bg-sidebar`, `bg-inspector` | side panes |
| `--ink`, `--ink-2`, `--ink-3` | `text-ink*` | primary, secondary, tertiary text |
| `--line`, `--line-strong` | `border-line*` | hairlines |
| `--accent` | `text-accent`, `bg-accent-soft` | links, focus, unread, selection |
| `--live`, `--attention`, `--danger` | `*-soft` tints exist | status colors |
| `--user-bubble` | `.message-bubble[data-role="user"]` | the one bubble in the transcript |
| `--room-accent` | `bg-room-soft`, `border-room` | the selected bot's color, set on the chat pane |

Legacy shadcn names (`background`, `foreground`, `muted`, `border`, `ring`, `popover`, …) are
mapped onto this palette so older code keeps rendering, but new code should use the names above.

## Shape, space, motion

- Radii: 6 (controls), 10 (inputs, cards), 14 (dialogs, bubbles), pill for chips.
- Sidebar rows are 54px on a 58px pitch; the chat header is 48px; details panel 320px by default.
  The sidebar's unread-jump math mirrors those numbers, so change them together.
- Shadows: `shadow-card` (hairline + 1px lift), `shadow-pop` (popovers), `shadow-modal` (dialogs).
- Motion: 120 to 200ms ease-out for state changes; 240ms `cubic-bezier(.22,1,.36,1)` for
  entrances. Reduced motion is honored globally. Animation names referenced from JS
  (`message-row-enter`, `a2a-exchange-sheet-*`) must not change.

## Primitives

`src/renderer/components/ui` holds the shadcn-style primitives (button, input, textarea, select,
switch, checkbox, dialog, alert-dialog, dropdown-menu, context-menu, popover, tooltip, badge,
kbd, card, separator, skeleton, progress). Shared product pieces live in
`src/renderer/components/openteam`: `status.tsx` (presence dot and text), `empty-state.tsx`,
`brand.tsx` (glyph and wordmark), and `avatar.tsx`.

## Contracts to keep

Tests in `test/*-parity.test.ts` pin the behavioral contracts of these surfaces: `data-*` hooks
read by performance scripts, aria labels, lazy import boundaries, localStorage keys, and the copy
that other clients depend on. Update them deliberately when a contract changes.
