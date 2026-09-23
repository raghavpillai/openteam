# Conversation compaction

OpenTeam begins background summarization at **90% of the active model's context window**, rounded up to the next whole token. Pi exposes the window through `session.model.contextWindow` and `session.getContextUsage().contextWindow`; the threshold is not based on message count or the model's output-token limit.

| Model context window | Normal compaction trigger |
| --- | --- |
| 32,000 | 28,800 |
| 64,000 | 57,600 |
| 128,000 | 115,200 |
| 256,000 | 230,400 |
| 1,000,000 | 900,000 |

Usage includes the model request, including system instructions and tool definitions. OpenTeam keeps the latest valid provider measurement and counts newly appended text with the o200k tokenizer, using the larger of that count and the previous character-based estimate. Tool results reserve space for provider framing and the untrusted-data fence. Repeated counts use a bounded cache; encoded image bytes are excluded from text counts. When provider usage is unavailable or stale after compaction, OpenTeam estimates the effective context, including system instructions and tool schemas. These remain estimates: other model tokenizers, image accounting, and provider framing can differ. The trigger remains 90% of the model's advertised window.

The summary runs in the background. A completed summary can replace the captured history at the next model step or turn-end check at the same 90% boundary. Unfinished background work can survive into the next turn; ordinary pressure does not block the user's completed response while waiting for it. Before another main-agent request, OpenTeam waits for a pending summary if estimated usage reaches the advertised context window or the image limit. The wait is cancellable and keeps messages received during compaction. Consequently, the archive may become visible above 90%. Explicit provider early thresholds, the 85-image trigger, manual compaction, and context-overflow recovery remain separate exceptions.

## Retained history

The system instructions remain separate. The active context retains user information, the latest user request, a summary inside `<summary_content>`, and messages that arrived while summarization ran. Tool-call/result pairs crossing that boundary stay together. Completed turns adopt ready summaries through the archive directly, including turns ending in a terminal tool result. They do not depend on Pi finding a transcript cut point. Pending tool calls are represented as pending in summarizer input rather than synthetic failures; their real results remain in the continuation tail. Injected reminders cannot replace the latest genuine user request. The original captured messages remain in the durable archive, and reopening a session restores its compacted context without treating old usage as fresh pressure.

## Summary content

The summary prompt requests a factual handoff with these sections, omitting empty sections:

- **Task and context:** current objective, project, and scope.
- **Decisions and constraints:** corrected values, exact identifiers, preferences, restrictions, and authorization boundaries.
- **Progress and evidence:** completed actions and observed results, separated from plans and unverified claims.
- **Current state:** active work, blockers, pending approvals, and relevant browser/computer state.
- **Next steps:** remaining work and prerequisites in order.

Later compactions preserve relevant facts from earlier summaries and merge subsequent corrections. Corrections are applied in message order, with one authoritative current value per field; an older summary calling a value “latest” cannot override a subsequent correction. Each handoff must stand alone: exact still-relevant ledger values cannot be replaced with references to earlier summaries. Temporary subtasks do not erase older unfinished objectives. A restriction on echoing facts in user-facing replies remains in force, while the internal summary retains those facts. The shorter-output retry retains the same requirements. The summarizer cannot execute tools.

This structure approximates an observed GrokBot native summary. It is not a claim that OpenTeam knows the current remote GrokBot compaction prompt or will produce identical prose. Summaries are lossy; neither the prompt nor a successful fixture guarantees perfect recall for every conversation.

## Measurements

Archive `tokensAfter` is an estimate of the effective context, not provider-measured usage. Optional archive metrics record generation completion and duration separately from adoption time, summary input/output tokens when the provider reports them, and retained-tail size. The first successful model response using an adopted summary records actual request input tokens in the durable `openteam-compaction-usage` session entry and `compaction.first_request` log. This measurement survives session reopening and includes system instructions, tools, summary, and retained messages. Content-free adoption and capacity-wait logs distinguish generation time, idle adoption delays, and time spent waiting at the window limit.

## Verification

The compaction tests cover threshold boundaries, small and large model windows, Pi session reopening, background adoption, stale usage, overflow recovery, retained tool exchanges, and durable archives. From `apps/computer`, run:

```sh
bun test ./test/bot-compaction.test.ts ./test/compaction-parity.test.ts ./test/compaction-provider-history.test.ts ./test/runtime/compaction.test.ts ./test/runtime/compaction-lifecycle.test.ts
```

The optional live quality probe uses an existing Pi credential in memory and synthetic history; it executes no tools. It checks normal summaries, shorter-output retries, and a second compaction with new corrections. It writes generated summaries and exact recall results to the selected output directory:

```sh
OPENTEAM_COMPACTION_QA_AUTH_PATH=/path/to/existing/pi/auth.json \
OPENTEAM_COMPACTION_QA_OUTPUT=/tmp/compaction-quality \
bun apps/computer/scripts/test-compaction-quality.ts
```

The default provider/model is `openai-codex` / `gpt-5.6-sol`; override with `OPENTEAM_COMPACTION_QA_PROVIDER` and `OPENTEAM_COMPACTION_QA_MODEL` when needed. This probe makes live inference calls and measures continuation quality, not natural context-window saturation or performance parity.
