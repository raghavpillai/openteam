# Grokbot email draft behavior investigation

Date: November 12, 2026. Goal: compare Grokbot's draft lifecycle and model feedback with OpenTeam, especially the repeated completion messages after 24 approvals.

## Live observations from the earlier tests

Two isolated bots, `Email Draft QA Nov 12` and `Email Past Discard QA`, were used for synthetic drafts. No test emails were sent.

- The agent could not discard a current draft, an older draft, several drafts, or a draft explicitly selected through a reply. It did not expose a model-facing cancellation tool in these tests.
- Manual Discard worked and automatically prompted a bot follow-up.
- A revised draft created another card; the earlier card remained available to send.
- Discarded cards expanded into read-only details and stayed discarded after navigating away and back.
- Same-subject versions confused the agent's explanation of which version had been discarded. This does not prove that the actual UI action targeted the wrong card.
- Unsubmitted edits were lost after navigation.
- Invalid recipients and an empty body disabled Send.
- A synthetic attachment appeared inside its review card with Open and Save controls. Its tool input used an array of absolute file paths.

The six earlier cards (QA-A, QA-Bv1, QA-Bv2, QA-C, QA-D and QA-E) were manually discarded. After restarting Grokbot as requested, QA-F (`QA-F attachment review`) was also discarded. Its automatic acknowledgement appeared at 15:06:16 ET. Nothing was sent.

## Installed client code observations

These are read-only observations of `/Applications/Grok Bot.app/Contents/Resources/app.asar`, not observations of the private server implementation. Relevant extracted files are in `/tmp/grokbot-email-inspection/`.

- The card's discard callback sends `discardDraft({entryId, agentId, sessionId?})`. It identifies the transcript entry rather than a subject string.
- Sending uses `sendDraft({entryId, draft, agentId, sessionId?, shownSignatureHtml?, macMail?})`.
- The desktop bridge calls `discardGrokBotDraft` or `sendGrokBotDraft` and maps a non-refused response to `{status: "ok", value: {accepted: response.accepted}}`. Refusals take a separate error path.
- Therefore the immediate UI acknowledgement is an acceptance boolean, not a Gmail delivery receipt. It is also separate from the model-facing result of `DraftExternalMessage`.
- The coordinator routes these actions to its temporal scope. The inspected desktop code does not establish whether that backend coalesces multiple outcomes, how many model runs result, or the exact outcome text supplied to the model.

Evidence locations: `electron-main-main-app.cjs` (`case "sendDraft"`, `case "discardDraft"`), `node-agent-coordinator-main.cjs` (action routing), and `chunk-view-DyemHoCF.js` (card callbacks) in the extraction directory.

The live sender account is anonymized as `sender@example.com` in this report.

## Model-facing results reported by Grokbot

The following text was reported by the test bot when explicitly asked what it had received. This is model self-report, not independently captured server traffic. The Activity panel did not load its tool details, so it has not been corroborated against the raw tool trace.

For successful creation, it reported one plain-text string:

> Draft email from sender@example.com to draft-qa@example.com is now an editable card in the chat (message id: t2s1). Nothing has been sent; the user reviews, may edit, and sends or discards it from the card, or tells you in a later message to send it.

It reported that creation did not repeat the subject, body or attachments. For QA-F's discard, it reported:

> [The user discarded your email draft to draft-qa@example.com (subject "QA-F attachment review") without sending it. Treat it as declined: nothing was sent. Do not send that message yourself (including via CallDynamicTool or any connector send tool), and do not ask them to press Send on it. Send the user one brief SendToUser line acknowledging the discard, then continue without it or ask what they want instead.]

It said this notice omitted the card/message ID, body, edited content, attachments, timestamp and sender address. Matching the recipient and subject was therefore its way to identify the card. That is consistent with the earlier same-subject revision confusion, but does not independently prove the server event's full structure.

## Six-card live test

Six review-only cards were created at 15:07:12–15:07:19 ET, with subjects `BATCH-QA-01` through `BATCH-QA-06`. The bot reported creation IDs `t4s1` through `t4s6`. Each UI card was then manually discarded. No Send action was used.

The visible automatic replies were:

| Time ET | Newly acknowledged discard |
| --- | --- |
| 15:09:25 | BATCH-QA-06; 01–05 still pending |
| 15:09:33 | BATCH-QA-05; 01–04 still pending |
| 15:09:51 | BATCH-QA-04; 01–03 still pending |
| 15:10:35 | BATCH-QA-02; 01 and 03 still pending |
| 15:10:40 | BATCH-QA-03; only 01 still pending |
| 15:10:47 | BATCH-QA-01; all six discarded |

Thus six discards produced six distinct acknowledgements, each identifying newly settled work. These were not six repetitions of an already-completed whole-batch summary. At 15:13:45 ET, the bot reported that it received six separate notices, each with the same acknowledgement instruction and a different subject. All six cards were visibly Discarded before this question was submitted.

UI scrolling and an Activity-panel recovery meant this was not a simultaneous six-event backlog. It does not establish coalescing behavior under a long-running turn.

Computer use initially failed with macOS AppleEvent timeout `-1712`. Terminating and reopening the app restored access. The Activity panel subsequently stopped accepting input; a second restart preserved the draft cards and restored interaction. No approval settings were changed.

## Active-turn test

Three additional review-only cards (`QUEUED-QA-A`, `QUEUED-QA-B`, `QUEUED-QA-C`) were created at 15:17:50–15:17:52 ET. The bot was instructed to run a foreground 60-second wait after creation so that card actions could be tested during an active turn.

All three cards were manually discarded in C, B, A order. The visible acknowledgements appeared at 15:20:07, 15:20:09 and 15:20:20 ET, respectively. The first acknowledgement reported that the wait had been interrupted rather than finishing normally.

At 15:21:23 ET, the bot reported three separate notices, creation IDs `t6s1`, `t6s2` and `t6s3`, and no card ID in any discard notice. It reported running `date; sleep 60; date` with a 90-second limit, and quoted this tool result:

> Error: Shell command was interrupted by the user after 128789ms before it completed.

The bot explicitly said no command output was returned, so it could not establish when the sleep actually began or why the elapsed duration exceeded both the requested wait and timeout. Its attribution of that interruption to the first discard is an interpretation consistent with the visible timing, not proof from an independently captured backend trace. The final question had reached the bot despite the UI snapshot not updating; another app restart exposed the completed response.

This produced three per-card acknowledgements rather than repeated whole-batch completion summaries. It still does not establish how a simultaneous 24-event send backlog would be handled, and the wait did not finish as a clean 60-second control. All nine newly created cards and the earlier QA-F card are now visibly Discarded. No Send action was used.

The final diagnostic response also confirmed that the agent had no email-card discard tool (its X-draft discard tool was a different capability), that sent-email outcomes remained untested, and that no research work was still running. The composer was empty after reopening the app.

## Recommendation so far

Copy the observed review-card lifecycle and explicit outcome feedback. Preserve OpenTeam's card IDs in outcome context rather than copying Grokbot's reported subject-only identification. Do not copy the instruction to always send one chat acknowledgement per card: even the six-card test produced six replies.

Keep the local OpenTeam batching fix, justified by its own production evidence and database regression. Do not describe its notification policy as identical to Grokbot. This investigation tests discard feedback; it cannot alone prove that send completions have identical behavior. No external mail has been sent as part of the research.

## Independent fresh-bot experiments

Three new Grokbot bots were created through the native UI, with fresh conversations and their default model/settings. Each was explicitly instructed never to send email, create mailbox drafts, change approval rules, save memories or use helpers. Eleven additional native review cards were created and manually discarded. The bots remain available as research history.

### Draft Outcomes Fresh A — edits and discard

One card, `FRESH-A-EDIT` (`t0s1`), was created at 15:30:27 ET. Changing To to `invalid-recipient` visibly disabled Send. To was then changed to `edited-qa@example.com`, the subject to `FRESH-A-EDIT changed locally`, and the body to `Locally edited synthetic body; do not send.` Send became enabled again, but was never used.

Discard collapsed the card back to its original recipient and subject. Reopening showed the original body `Version A original body. Review only.`, with no editable fields or Send control. Its automatic acknowledgement at 15:31:46 named the original subject. At 15:32:23, the bot reported the same creation receipt and discard wording seen in the earlier bot: original recipient/subject, no body or card ID, and an instruction to give one brief acknowledgement. It could not determine from that notice whether local edits had occurred. It confirmed the test was stopped.

### Draft Outcomes Fresh B — eight-card burst

Eight cards `FRESH-B-01`–`FRESH-B-08` were created at 15:31:09–15:31:17 ET, with reported IDs `t0s1`–`t0s8`. Card 08 was discarded first; the other seven were clicked in descending order using fresh accessibility controls after every action, in a roughly 14-second pass including scrolling. The UI subsequently showed all eight as Discarded.

Before the next user message, only three visible acknowledgements appeared:

- 15:32:44: card 08 discarded.
- 15:33:14: card 02 discarded.
- 15:33:19: card 01 discarded, followed by the incorrect assertion that cards 03–07 were still open.

At 15:34:08, in response to a diagnostic question, the bot reported that it had received 08, 02 and 01 as separate incoming notices. It said outcomes 03–07 arrived together in a combined summary alongside that diagnostic user message, with a note that their original turns had been cut off before it saw them. It corrected its earlier assertion about five open cards. This is evidence of a later combined summary as reported by the model; the private server's queue/interrupt implementation was not independently captured.

This fresh-bot result is more informative than the earlier slow six-card pass: rapid actions can leave acknowledgements incomplete or stale until another natural turn, even though every UI card settled correctly. The bot confirmed no research work remained running.

### Draft Outcomes Fresh C — revisions and historical identity

The original `FRESH-C-SAME` (`t0s1`) said Monday at ten. A revision in a later user turn created a second card (`t1s1`) at 15:32:36 ET, with Tuesday at eleven highlighted. The original stayed sendable. Asking the bot to discard the older card by ID produced a refusal at 15:34:31: its tools could not discard email review cards.

The original card was then manually discarded, and reopening it showed its original Monday body read-only. The newer Tuesday card remained editable until separately discarded. The first acknowledgement at 15:35:12 explicitly could not identify which version had been discarded: “If it was the Monday one (t0s1), the Tuesday card (t1s1) is still up”. After the second discard at 15:35:29, it acknowledged both were gone.

At 15:35:48 the bot reported that both notices were identical and contained neither card ID nor body. It could not distinguish their order from those notices alone. It confirmed the research had stopped.

## Resulting local OpenTeam changes

- Settled-draft wakes now identify the card, outcome ID, state, recipient and subject directly, rather than relying on a generic wake plus transient ambient context. Full content stays in the stored receipt.
- Discard feedback explicitly rejects sending the declined message or asking the user to press Send on it.
- Ready outcomes still share one continuation. Batching retains every individual notice, including distinct IDs for identical subjects. Acknowledgement guidance asks for one brief message and warns against inferring that unmentioned cards remain open.
- Reopened discarded cards show their stored original fields and body on desktop and iOS. Unsubmitted local edits are not presented as persisted history.
- Approval rules, agent cancellation capabilities and send authorization are unchanged. No interruption system or new model-facing cancellation tool was added.

Initial validation passed: nine worker/background-revival tests; six real PostgreSQL draft integration tests (83 assertions), including identity retention after ambient receipt acknowledgement and 24-to-one claiming; four desktop UI combinations (light/dark, wide/narrow) including local edits before discard; server/worker/desktop TypeScript checks; desktop production build and performance budgets; iOS simulator build. Tests use mocked mail transports and synthetic data. See the later PR comparison below and the [A/B report](draft-notification-ab-2026-11-12.md) for expanded validation. No production deployment was made.

## PR comparison — fresh fourth bot

On November 12, a new native bot, `Email PR Comparison`, created six review cards at 16:42:15–16:42:20 ET. Cards 1 and 2 shared subject `PR-COMPARE-SAME` but had distinct numbered bodies. Cards 3–6 used subjects `PR-COMPARE-03` through `06`. All addressed `draft-qa@example.com`. The prompt prohibited sending mail, mailbox drafts, approval changes, memory and helpers. The bot declined to disclose creation IDs in this conversation; that refusal is model behavior, not evidence that its creation tool omitted IDs.

Manual action order was 1, then 6, 5, 4, 3, 2, with fresh accessibility observations after each click. The first acknowledgement completed before the remaining actions. The final five discards spanned roughly ten seconds, including scrolling. All six cards visibly settled as Discarded. Reopening card 4 showed its original body read-only, with no Send control.

Before any diagnostic follow-up, three automatic messages appeared:

- 16:42:47: one same-subject draft discarded; five still awaiting review (accurate then).
- 16:43:14: card 3 discarded; four left to review (stale: cards 4–6 had already been discarded).
- 16:43:21: the other same-subject card discarded; cards 4–6 still remained (false: all six were discarded).

At 16:44:03, after a diagnostic user question, the bot corrected the stale count. It reported three individual notices (same subject, card 3, same subject) and a combined catch-up notice for cards 4–6 saying their individual notices had been cut off. It said the notices carried recipient, subject and discard state, but neither card ID nor body, so it could not establish which same-subject version was discarded first. Those internals are model self-report; no private server trace was available. The bot confirmed all test work stopped. No Send button was clicked.

The matched OpenTeam regression creates the same subjects/bodies and discards in the same order, with one worker claim after card 1 and one after the remaining five. It verifies two canonical messages (five pending, then none pending), six distinct outcome IDs covered exactly once, all six bodies retained in stored receipts, and zero mocked mail sends. Injecting the stale four-pending model reply creates no extra text under treatment. All twelve PostgreSQL tests pass with 193 assertions.

This is a matched scenario comparison, not a randomized live-model A/B benchmark. Grokbot used a live model and native UI; OpenTeam used real PostgreSQL/worker claim/message persistence with mocked transport and injected model text. Worker claim timing was staged explicitly in OpenTeam, and the production treatment remains off by default. The separate desktop Electron fixture verifies real card interactions. The result supports the identity/counting design and exposes a reproducible reference failure; it does not establish comparative latency or real-world error rates.
