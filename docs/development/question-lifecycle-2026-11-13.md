# Question lifecycle in Grok Bot and OpenTeam

Ordinary question cards stop being actionable when the user sends another message. The message remains normal conversation: it can answer the question in context or change the subject. Only submitting the card records a structured answer. OpenTeam applies this rule durably on the server and projects it immediately on desktop and iOS.

## Native Grok Bot observations

The macOS Grok Bot 1.0.1 app was exercised on November 13, 2026 in the isolated bot `Question Lifecycle QA Nov13`. All choices were synthetic; the bot was instructed not to use connectors, send external messages, run commands, create files, save memories, or delegate.

| Interaction | Observed result |
| --- | --- |
| Ignore a Red/Blue card and ask what 2 + 2 is | The card immediately becomes Dismissed, loses its buttons, and the composer returns to its normal prompt. The bot answers 4. |
| Leave an unanswered Circle/Square card, switch to another chat, and return | The card remains actionable and the question composer hint remains. The earlier dismissed card stays dismissed. |
| Send another unrelated message after returning | The Circle/Square card immediately becomes Dismissed. |
| Ask to revisit the earlier color question | A fresh card appears. The original remains dismissed. Selecting Blue on the fresh card displays Your answer: Blue. |
| Type Blue into the main composer while a Red/Blue card is open, then press Enter | Blue appears as a normal user message. The old card becomes Dismissed, without a structured answer. The bot replies that Blue was selected based on the conversation. |
| Select Alpha and draft Gamma in a multi-select card, then send an unrelated chat message | The card becomes Dismissed. The selected option and unfinished custom answer are not submitted. |
| Type Skip that sample choice | The card becomes Dismissed as the normal message is sent. |
| Inspect the sidebar while a question is pending | A blue unread dot appears; no orange star is shown. The composer says Type your answer, or talk about something else. |

The final synthetic choice remained actionable for roughly eleven minutes before the final skip message. This establishes neither a days-long lifetime nor a universal age timeout.

The tested single-choice card's context menu offered reply, copy and request-ID actions. No separate dismiss control appeared in that card's accessibility tree or screenshot. The installed renderer nevertheless has an explicit dismissal path. OpenTeam retains its existing explicit Dismiss control.

### Unselected chats and notifications (November 14 follow-up)

With `Draft Timing Parity A` selected, the research bot's pending question appeared in the sidebar as `QUESTION PREVIEW TEST: Which sample color?`, with the usual blue unread dot. Its help text (`Choose a sample for this test.`) and Red/Blue choices appeared inside the card but not in the sidebar preview. There was no star, checklist glyph, or other question-specific avatar/preview marker. A second Cat/Dog question produced the same prompt-only sidebar preview. Reopening that question cleared the unread dot while leaving its choices actionable.

The installed renderer's `gH` returns the ordinary widget prompt as its message summary. The installed Electron main bundle has separate notification formatting (`uUt`) and focus gating (`Hyr`, `Lgr`, `Ugr`). In the desktop chat route, focus suppresses the conversation on screen; a different conversation and an unfocused app remain eligible, subject to read state, notification preferences, throttling and deduplication. Notifications use Electron's native notification API with a title and body, and clicking opens the conversation/message. There is no question-specific icon or answer-button configuration in that constructor.

For ordinary message notifications, the title is the bot's display name and the body comes from the latest preview, with whitespace normalized and a 140-character limit. Its preview formatter supports `widget_prompt` as well as `widget_options` and `widget_answered` payloads. Approvals that set `awaitingUserResponse` have a separate needs-input notification path and copy.

macOS initially had Grok Bot notifications disabled, with temporary banners selected underneath the disabled setting. The user's permission was obtained before temporarily enabling notifications for the live test. The `BANNER TEST: Which sample animal?` question was generated three seconds after the prompt while Grok was hidden; inspecting the hidden window initially returned stale state. No native banner screenshot was captured. macOS also had notifications while mirroring/sharing set to Notifications Off; this global setting was left unchanged. The app's notification permission was restored to off and verified in System Settings. The synthetic question was subsequently dismissed by a stop message, and the bot acknowledged `Test stopped.`

The exact notification payload was subsequently recovered by reading macOS's notification history database in read-only mode, filtering to `com.anysphere.sand` and the isolated research bot. The stored notification had `presented = 0`, consistent with no visible banner during this test. Its actual text was:

| Field | Grok Bot notification |
| --- | --- |
| Title | `Question Lifecycle QA Nov13` |
| Body | `BANNER TEST: Which sample animal?` |

The body contains only the question prompt: no “asked a question” prefix, help text, or Cat/Dog options. The following ordinary response used the same bot-name title and `Test stopped.` as its body. OpenTeam's title/body composition is checked against the actual question payload in `packages/messaging/test/notification-body.test.ts`. The text is verified; exact native banner pixels remain unverified.

### Additional interaction tests (November 14)

The same isolated bot was exercised with fresh `PARITY-Q6` through `PARITY-Q9` cards. No connectors, commands, external messages, files, memories, or delegation were requested or used.

| Case | Grok result | OpenTeam result/change |
| --- | --- | --- |
| Select Alpha, draft Gamma, navigate to a different chat and back | Both unfinished inputs remain; the card is still actionable | Desktop session drafts and iOS channel drafts already preserve navigation state |
| Reload the desktop app with those unfinished inputs | The question remains open; the selection and custom text reset | Matches OpenTeam desktop's session-only question draft store |
| Press the next letter after the option shortcuts | Focuses the inline custom answer field | Added this desktop shortcut and the Something else placeholder |
| Press Done on a multi-select card with nothing selected or typed | Card becomes Dismissed, with no structured answer; no new bot reply appeared before the next user message | Skip is a separate, always-available action that dismisses explicitly; Send answer stays unavailable while the card is empty |
| Submit Alpha plus custom Gamma | Your answer displays Alpha and Gamma, and the bot acknowledges both | Existing combined answer construction matches; Electron regression covers it |
| Press Enter in an empty single-choice custom field | Card remains open and no answer is submitted | Existing empty-answer guard matches |
| Send later normal messages after structured answers | Earlier Your answer receipts remain resolved | Covered by both client projections and history tests |
| Confirm text during IME composition | Installed widget code explicitly ignores composing Enter events | Added the missing desktop guard; regression verifies no submission |

The empty Done dismissal is deliberately distinct from Enter in an empty custom field, which does nothing. Installed `chunk-widget-Dr8msTuD.js` corroborates both paths: the Done handler dismisses when its assembled answer is empty, while the custom-field Enter handler ignores empty answers and IME composition.

An additional OpenTeam update-ordering test exposed a gap independent of the native experiments: a newly published question could render alongside its still-pending predecessor until the predecessor's canonical update arrived. Desktop and iOS projections now retire the predecessor immediately in the same scope, without mutating cached rows. The regression failed before this fix and passes afterward; the server already persisted the same invariant.

Remaining parity limits are explicit. Exact macOS banner pixels, genuine multi-day question aging, simultaneous questions from independent Grok background work, and interactions across two real Grok clients have not been verified. Grok's dismissed cards retain faded option text; OpenTeam desktop and iOS use a compact receipt. iOS persists question drafts across app launches, whereas the tested Grok desktop reload clears them; Grok's iOS behavior was not tested. These are not evidence for inventing an age timeout or changing approval lifetimes.

### Fault injection and concurrency (November 14)

Grok's settled history was rechecked after a native desktop reload: Q6 and Q9 remained Dismissed, Q7 retained Alpha/Gamma, and Q8 retained its custom answer. The composer returned to its normal state. This verifies the visible reload behavior, not Grok's private server fault handling.

OpenTeam was then exercised with delayed and duplicated pages, window replacement, search-context changes, reversed timestamps, competing replies, lost acknowledgements, and transaction failure. Three reproduced faults were fixed:

- Replacing a history window could forget a settled receipt, letting a stale page reopen the same question. Desktop's actual `useOpenTeam` hook, the shared window store, and iOS now retain bounded canonical receipts independently from visible rows and restore them across primary, thread, search and cached-tail lanes. New payload fields still update; the original answer/dismissal cannot change. Receipts retain only settlement metadata, with limits of 500 entries and 256 KiB estimated storage per warm channel; channel/account eviction clears them.
- Desktop question projection previously followed rendered timestamp order. A transaction that started earlier but acquired the channel lock later could leave an earlier question pending. Projection now follows accepted server sequence, including integers beyond JavaScript's safe-number range, while preserving the existing display order.
- Two simultaneous direct sends with the same nonce could both pass the preliminary deduplication check. The second failed a unique constraint after waiting for the lifecycle lock. Direct sends now recheck idempotency under the lock and return the first receipt without creating another message or settling a newer question.

TypeScript and Swift each run 100 deterministic seeds with 80 transitions: 8,000 delayed/duplicate/replaced-window transitions per platform. The TypeScript matrix also exercises answered and dismissed receipts from every history lane. The real Electron hook test evicts the original question, loads a stale copy through message context, clears and reopens that context, and verifies both answer and dismissal receipts. The native iOS test dismisses a question, reopens its chat against a stale page, waits for a separate marker from that same page to appear, then verifies the card has no answer controls.

PostgreSQL fault coverage adds rollback after settlement/event insertion, sixteen five-request races (duplicate structured responses, explicit dismissal, duplicate normal sends), retry after a lost acknowledgement, questions published by independent worker runs, replay of an older publication nonce, publication racing the previous answer, and fork isolation. Only one terminal outcome and one normal message persist; only a winning structured answer produces its response wake. The existing same-run pending-question guard remains enforced. Durable approval state remains independent.

These caches protect canonical receipts actually observed by the client. They do not retain unlimited history, fabricate answers from projected dismissal, or replace the server's durable authority after eviction/relaunch. Optimistic sends still depend on their existing local timestamp ordering; local clock skew before acceptance was not established as equivalent to Grok. Real two-client Grok races, process death inside Grok's server, and arbitrary multi-day behavior remain unverified.

### OpenTeam question card

The interaction contract is the one described above; the card itself is OpenTeam's own design, the same on desktop and iOS.

Each option is a tile with a real selection control: a checkbox when several answers are allowed, a radio when one is. Selected tiles fill their checkbox and gain an outline. A custom answer is the last tile, typed into directly. Desktop tiles also show their keyboard shortcut letter; touch layouts hide it.

One footer holds the actions. **Skip** is always available and closes the card without an answer (accessible name: Skip question). Multi-select cards add **Send answer**, which stays unavailable until something is selected or typed. Single-choice cards answer on the first tap; a typed custom answer gets an inline send button. The footer also says **Or reply in chat**; on a card too narrow to fit it beside the buttons, iOS drops the hint and the composer placeholder carries the same message.

Closed cards shrink to a receipt. An answered card lists each answer beside a green check. A card closed any other way keeps its prompt and shows one status chip: **Continued in chat**, **Skipped**, or **Replaced**. The longer explanation ("This question closed when you sent a message.", "No answer was sent from this card.", "A newer question took its place.") is the desktop tooltip and the assistive-technology description on both platforms. A typed chat answer is never presented as a structured card answer.

An empty multi-select card sends nothing from its primary button. The separate Skip action gives the same result as pressing Done on an empty card in the reference app.

### Question-card motion

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

## Installed client behavior

Read-only inspection of the installed `app.asar` agrees with the native observations. In the renderer bundle `index.eager-app-C1EubAxZ.js`, `WH` computes historical dismissed widgets by scanning backward across real user-message boundaries and settled widgets. `KJt` selects the current question, stopping at those same boundaries. `RR` distinguishes active, resolved and dismissed presentation. Synthetic system notices are excluded from ordinary user boundaries by `HJt`.

A card submission goes through `respondToWidget`; explicit dismissal uses `dismissWidget`. Normal composer sends go through `sendPrompt`. The renderer also contains an opportunistic answer-settlement path with per-card deduplication; the live typed-Blue test did not display a structured answer on its card. These findings describe the shipped client, not the private server implementation.

## Different request lifetimes

Question cards are distinct from approvals, drafts, credentials, forms and computer handoffs. Grok's [troubleshooting documentation](https://docs.x.ai/grok-bot/troubleshooting#an-approval-expired-or-is-blocked) says approvals from background work expire after about 30 minutes, while approvals from a chat the user is participating in wait for the user. The [November 6 changelog](https://x.ai/changelog/bot) says abandoned computer handoffs stop showing Waiting for you after 24 hours. Neither rule establishes an age timeout for ordinary questions.

## OpenTeam implementation

Every newly accepted normal message retires outstanding questions in that conversation scope, including typed answers, attachments and replies. Retries of an already accepted message do not dismiss a question published afterward. Answering a retired question from a stale client returns the authoritative card without waking a bot.

Question publication, normal messages, answers and dismissals share a per-channel transaction lock. Publication retires an earlier open question in the same scope, giving OpenTeam one active question per scope. This is an OpenTeam invariant; concurrent background Grok questions were not exercised. Main conversations and fork roots have independent scopes. A fresh card never revives its predecessor.

The database preserves `respondedValue` for explicit card answers. Dismissal preserves the question and records `widgetDismissalReason`: `moved-on`, `dismissed`, or `superseded`. Model context distinguishes moving on from an explicit decline: a normal message may supply the answer, while silence and skipped questions never grant permission. Dismissal does not generate a separate conversational wake.

Desktop and iOS derive the same historical presentation without rewriting cached messages. Optimistic sends close questions immediately; removing a definitely rejected send can restore the still-pending card. Server settlement prevents history paging, relaunches and reconnects from reactivating retired questions. Structured answers remain visible after later messages.

iOS custom answers live inside the card and have an explicit Submit button, separate from the normal composer. Both clients show the contextual question hint. Ordinary questions no longer create iOS's persistent orange star; requests such as pending drafts and credentials retain their independent attention state.

The November 14 follow-up also removes iOS's question-preview checklist icon and appended help/options. Shared desktop/server summaries and iOS previews prefer the question prompt, with ordinary content as a malformed-card fallback. Notification bodies use the same shared summary. At the user's request, OpenTeam suppresses all banners while its window is focused, including other chats; banners remain eligible in the background. This intentionally differs from Grok's per-conversation focus gating. Existing read reconciliation, throttling and click routing remain in force.

The opt-in `dismissOnMoveOn` tool field and iOS's composer-to-widget answer path were removed. There is no compatibility mode or data backfill. Existing unanswered cards settle on the next accepted message; presentation also respects later messages already in loaded history. No new age-based expiration is inferred for ordinary questions.

## Validation

- **168 TypeScript tests** pass across product-core and question-notification coverage, including 12 chaos tests. **305 Swift core tests** pass, including the seeded receipt-history fault suite.
- **Four PostgreSQL tests / 159 assertions** pass across question lifecycle, widget integration and durable message acceptance. This includes the original eight answer/send races and sixteen additional mixed races.
- **Six Electron scenarios** pass: four direct/group/light/dark interaction cases and two real state-hook history replay cases (answered/dismissed). Run the latter with `bun --filter @openteam/desktop test:question-history:chaos`. The interaction cases check the tile controls, that an empty card cannot send, the Skip action, each closure reason, and the motion checks listed above.
- **Six native iOS UI tests** pass: Skip dismisses without an answer and Send answer stays unavailable until something is selected; a normal composer send abandons an unfinished card draft without a widget action and the card minimises; stale history does not reopen a dismissed card; answering collapses to the receipt; skipping removes the options and shrinks the card, also under reduced motion; completed cards keep labelled, checked answers in both themes. Xcode 27.3 builds the app and tests for the isolated iOS 27.1 simulator.
- Desktop, server and product-core TypeScript checks, architecture boundaries and the desktop build pass.

The lifecycle work measured **1,339,214 B** for the workspace startup closure, versus **1,334,586 B** in the untouched same-base build (+4,628 B). The redesigned card brings it to **1,342,514 B** (limit 1,343,500). Its motion is a separate lazy module of 22,141 B (7,984 B gzip) with its own 23,000 B budget; the renderer totals move to 17,905,500 B and 4,484,500 B gzip to admit it. The size gate retains only the two independently reproduced baseline failures: preload 10,008 > 10,000 B and voice memo 67,330 > 64,900 B. Their modules and ceilings remain unchanged.
