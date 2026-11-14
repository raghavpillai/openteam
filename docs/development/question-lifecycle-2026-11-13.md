# Question lifecycle

Ordinary question cards stop being actionable when the user sends another message. The message remains normal conversation: it can answer the question in context or change the subject. Only submitting the card records a structured answer. OpenTeam applies this rule durably on the server and projects it immediately on desktop and iOS.

## Rules

Every newly accepted normal message retires outstanding questions in that conversation scope, including typed answers, attachments and replies. Retries of an already accepted message do not dismiss a question published afterward. Answering a retired question from a stale client returns the authoritative card without waking a bot.

Question publication, normal messages, answers and dismissals share a per-channel transaction lock. Publication retires an earlier open question in the same scope, giving OpenTeam one active question per scope. Main conversations and fork roots have independent scopes. A fresh card never revives its predecessor.

The database preserves `respondedValue` for explicit card answers. Dismissal preserves the question and records `widgetDismissalReason`: `moved-on`, `dismissed`, or `superseded`. Model context distinguishes moving on from an explicit decline: a normal message may supply the answer, while silence and skipped questions never grant permission. Dismissal does not generate a separate conversational wake.

Desktop and iOS derive the same historical presentation without rewriting cached messages. Optimistic sends close questions immediately; removing a definitely rejected send can restore the still-pending card. Server settlement prevents history paging, relaunches and reconnects from reactivating retired questions. Structured answers remain visible after later messages.

Custom answers are typed inside the card, separate from the normal composer. Both clients show the contextual question hint in the composer. Ordinary questions no longer create iOS's persistent orange star; requests such as pending drafts and credentials retain their independent attention state.

Question previews carry no question-specific icon and no appended help text or options. Shared desktop/server summaries and iOS previews prefer the question prompt, with ordinary content as a malformed-card fallback. Notification bodies use the same shared summary. OpenTeam suppresses all banners while its window is focused, including other chats; banners remain eligible in the background. Existing read reconciliation, throttling and click routing remain in force.

The opt-in `dismissOnMoveOn` tool field and iOS's composer-to-widget answer path were removed. There is no compatibility mode or data backfill. Existing unanswered cards settle on the next accepted message; presentation also respects later messages already in loaded history. No new age-based expiration is inferred for ordinary questions.

## Fault handling

Question state was exercised with delayed and duplicated pages, window replacement, search-context changes, reversed timestamps, competing replies, lost acknowledgements, and transaction failure. Three reproduced faults were fixed:

- Replacing a history window could forget a settled receipt, letting a stale page reopen the same question. Desktop's actual `useOpenTeam` hook, the shared window store, and iOS now retain bounded canonical receipts independently from visible rows and restore them across primary, thread, search and cached-tail lanes. New payload fields still update; the original answer/dismissal cannot change. Receipts retain only settlement metadata, with limits of 500 entries and 256 KiB estimated storage per warm channel; channel/account eviction clears them.
- Desktop question projection previously followed rendered timestamp order. A transaction that started earlier but acquired the channel lock later could leave an earlier question pending. Projection now follows accepted server sequence, including integers beyond JavaScript's safe-number range, while preserving the existing display order.
- Two simultaneous direct sends with the same nonce could both pass the preliminary deduplication check. The second failed a unique constraint after waiting for the lifecycle lock. Direct sends now recheck idempotency under the lock and return the first receipt without creating another message or settling a newer question.

TypeScript and Swift each run 100 deterministic seeds with 80 transitions: 8,000 delayed/duplicate/replaced-window transitions per platform. The TypeScript matrix also exercises answered and dismissed receipts from every history lane. The real Electron hook test evicts the original question, loads a stale copy through message context, clears and reopens that context, and verifies both answer and dismissal receipts. The native iOS test dismisses a question, reopens its chat against a stale page, waits for a separate marker from that same page to appear, then verifies the card has no answer controls.

PostgreSQL fault coverage adds rollback after settlement/event insertion, sixteen five-request races (duplicate structured responses, explicit dismissal, duplicate normal sends), retry after a lost acknowledgement, questions published by independent worker runs, replay of an older publication nonce, publication racing the previous answer, and fork isolation. Only one terminal outcome and one normal message persist; only a winning structured answer produces its response wake. The existing same-run pending-question guard remains enforced. Durable approval state remains independent.

These caches protect canonical receipts actually observed by the client. They do not retain unlimited history, fabricate answers from projected dismissal, or replace the server's durable authority after eviction/relaunch. Optimistic sends still depend on their existing local timestamp ordering.

## The card

### Layout

The card is the same design on desktop and iOS.

Each option is a tile with a real selection control: a checkbox when several answers are allowed, a radio when one is. Selected tiles fill their checkbox and gain an outline. A custom answer is the last tile, typed into directly. Desktop tiles also show their keyboard shortcut letter; touch layouts hide it.

One footer holds the actions. **Skip** is always available and closes the card without an answer (accessible name: Skip question). Multi-select cards add **Send answer**, which stays unavailable until something is selected or typed. Single-choice cards answer on the first tap; a typed custom answer gets an inline send button. The footer also says **Or reply in chat**; on a card too narrow to fit it beside the buttons, iOS drops the hint and the composer placeholder carries the same message.

Closed cards shrink to a receipt. An answered card lists each answer beside a green check. A card closed any other way keeps its prompt and shows one status chip: **Continued in chat**, **Skipped**, or **Replaced**. The longer explanation ("This question closed when you sent a message.", "No answer was sent from this card.", "A newer question took its place.") is the desktop tooltip and the assistive-technology description on both platforms. A typed chat answer is never presented as a structured card answer.

An empty multi-select card sends nothing from its primary button.

### Motion

Both platforms follow one choreography. Timings differ slightly per platform and live in `question-card-motion.ts` (desktop) and `QuestionMotion` in `QuestionCardMotion.swift` (iOS).

- **Arrival.** A question that arrives live brings its tiles in one after another, about 30 ms apart, then the footer. Loading history, reopening a chat or remounting a card never replays it.
- **Selecting.** A tile squishes on press and springs back. The checkbox fill grows from its centre with a little overshoot and the check draws just after; deselecting reverses quickly. Send answer fills in when it becomes available and deflates when it stops being available, without changing the footer's width. On single-choice cards the inline send button buds out of the custom field's trailing edge.
- **Answering.** The chosen tiles become the receipt rows: each control turns into the green check and each label travels to its receipt position. Everything else melts away while the card closes around what remains. A typed answer becomes a row and its pencil becomes the check. The prompt recolours in place.
- **Skipping.** The Skip button itself becomes the Skipped chip: it gathers into a blob, flies on an arc to the prompt's trailing edge, lands with a squash, and its icon and label resolve inside it.
- **Continued in chat / Replaced.** No button was pressed, so the chip grows out of the card's trailing edge while the tiles melt.
- **Failure.** A failed answer or skip reopens the card from wherever the animation had reached, and the error line eases in.
- **Reduce Motion.** No travel, blobs or springs; the new state appears at once (desktop uses a 140 ms fade). Turning it on mid-animation cancels the animation in the same frame.

A settle takes about 0.4–0.55 s. Blur-and-threshold goo is used only for the Skip blob and the chip bud, on a small stage that exists only while they move; the other shapes are spring-driven.

Platform differences:

- **Desktop** is optimistic: the request leaves on the click and the motion plays over it. The motion code is a separate module loaded with the first question card. A card remounted mid-animation (after a chat switch) shows its final state rather than resuming.
- **iOS** closes the card itself, on the tap, and sends the answer or skip about 0.3 s later (0.4 s for single choice), once the card has closed. The message list does not follow a row's height change that lands during one of its own updates, so letting the server's update arrive mid-close made the transcript jump. The card's state lives outside the view, so leaving the chat in that window still sends the request once. For the same reason a card closed by a chat message or a newer question shows its chip and dims at once, then closes when the transcript has been still for 0.75 s (1.2 s after an arriving message).
- **iOS haptics:** the existing light tap on press and selection tick, plus a soft tick when the receipt or chip lands. None of the new ones under Reduce Motion.
- A debug-only `--qa-question-motion-speed <x>` launch argument scales the iOS card's motion for recording; it does nothing without `--ui-testing`.

Verification. The Electron fixture checks the staggered arrival, no replay on remount, sixteen real height interpolations (four closure paths × light/dark × direct/group), that the leaving copy is inert, an interrupted failed-skip recovery, and that nothing is left on the card afterwards (no effect layer, inline style, running animation, filter or fixed height), with and without reduced motion. A separate 102-story break-it script (`output/`, not committed) covers rapid toggling, double clicks, answering and skipping during arrival, failures at several points in each animation with a retry, server echoes and replacement mid-flight, unmount/remount, resizing, narrow widths, long and many options, and reduced motion toggled mid-flight; it passed on the final code on both a real-time and a stepped clock. On iOS the same kinds of cases were driven on the simulator with scripts (rapid toggles with a triple-tapped Send, answering 0.15 s after arrival, a newer question during a skip, leaving and returning mid-answer, delayed and failed responses with a retry). Every transition on both platforms was reviewed frame by frame in recordings, including 0.25× captures.

Not verified: a physical iPhone (including how the haptics feel), VoiceOver, the packaged desktop app (only the dev server and a production build that compiles), and frame rate on a quiet machine. The iOS captures show 50–70 ms gaps near the start of some settles that were taken under heavy machine load; the list's own frame trace was clean through the same motion in other runs.
## Validation

Run on the branch after merging `main`:

- **Unit tests:** 154 product-core, 289 messaging (the 214 database-backed ones skip without a test database), 80 client-core and 673 desktop tests pass. 305 Swift core tests pass, including the seeded receipt-history fault suite.
- **Database:** four PostgreSQL tests with 159 assertions pass across question lifecycle, widget integration and durable message acceptance, including the answer/send races. Set `OPENTEAM_TEST_DATABASE_URL` to an empty database with the current schema.
- **Electron:** the four direct/group/light/dark interaction scenarios with the motion checks (`bun --filter @openteam/desktop test:widget-group-parity`) and the two state-hook history replay cases (`test:question-history:chaos`) pass.
- **iOS simulator:** six UI tests pass: Skip dismisses without an answer and Send answer stays unavailable until something is selected; a normal composer send abandons an unfinished card draft without a widget action and the card minimises; stale history does not reopen a dismissed card; answering collapses to the receipt; skipping removes the options and shrinks the card, also under reduced motion; completed cards keep labelled, checked answers in both themes.
- Desktop and server TypeScript checks and the desktop build pass.

Size: the signed-in startup closure measures 1,349,562 B (limit 1,350,500); the same build without the question work measures 1,341,722 B. The card's motion is a separate lazy module of 22,141 B with its own 23,000 B budget. The size gate reports only its two long-standing failures, preload (10,008 > 10,000 B) and voice memo (67,330 > 64,900 B).
