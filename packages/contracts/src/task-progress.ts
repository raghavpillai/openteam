import { Schema } from "effect";

const text = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8000));
export const TaskProgressInput = Schema.Struct({
  key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(160)),
  state: Schema.Literal("working", "waiting", "blocked", "complete"),
  summary: text,
  evidence: Schema.Array(text).pipe(Schema.maxItems(20)),
  remaining: Schema.Array(text).pipe(Schema.maxItems(30)),
  nextAction: Schema.optional(text),
  checkAt: Schema.optional(Schema.String),
  deadline: Schema.optional(Schema.String),
  blockSource: Schema.optional(Schema.Literal("user", "policy", "tool", "runtime")),
  toolError: Schema.optional(text),
});
export type TaskProgressInput = typeof TaskProgressInput.Type;
export type TaskProgress = TaskProgressInput & {
  runId: string;
  revision: number;
  tracking?: "initial";
  reconciliationRequired?: boolean;
};

export function validateTaskProgress(input: TaskProgressInput, now = Date.now()): void {
  if (JSON.stringify(input).length > 32000)
    throw new Error(
      "Task progress must fit within 32000 characters; keep references instead of transcripts"
    );
  if (![input.key, input.summary, ...input.evidence, ...input.remaining].every((s) => s.trim()))
    throw new Error("Progress values cannot be blank");
  const check = input.checkAt === undefined ? undefined : Date.parse(input.checkAt);
  const deadline = input.deadline === undefined ? undefined : Date.parse(input.deadline);
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    check !== undefined &&
    (!isoTimestamp.test(input.checkAt!) || !Number.isFinite(check) || check <= now)
  )
    throw new Error("checkAt must be a future ISO timestamp");
  if (
    deadline !== undefined &&
    (!isoTimestamp.test(input.deadline!) || !Number.isFinite(deadline) || deadline <= now)
  )
    throw new Error("deadline must be a future ISO timestamp");
  if (check !== undefined && deadline !== undefined && check > deadline)
    throw new Error("Check must occur no later than the response deadline");
  if (
    input.state === "waiting" &&
    (check === undefined || !input.remaining.length || !input.nextAction?.trim())
  )
    throw new Error("Waiting requires remaining obligations, nextAction and checkAt");
  if (input.state !== "waiting" && check !== undefined)
    throw new Error("Only waiting work can schedule a check");
  if (input.remaining.length && !input.nextAction?.trim())
    throw new Error("Unfinished work needs a nextAction");
  if (input.state === "complete" && input.remaining.length)
    throw new Error("Complete work cannot leave obligations unresolved");
  if ((input.state === "complete" || input.state === "working") && !input.evidence.length)
    throw new Error("A milestone needs evidence; an acknowledgement is not a milestone");
  if (input.state === "blocked" && !input.blockSource)
    throw new Error(
      "A block must identify whether it needs the user, follows a policy, or came from a tool"
    );
  if (input.blockSource === "tool" && !input.toolError?.trim())
    throw new Error("A tool block must include the actual returned error");
  if (input.blockSource && input.state !== "blocked")
    throw new Error("Only blocked work may name a block source");
  if (input.state === "blocked" && !input.remaining.length)
    throw new Error("A blocked task must identify its unfinished obligation");
  if (input.toolError && input.blockSource !== "tool")
    throw new Error("Only an actual tool block may include toolError");
}

/** Extension to the captured worker surface; WakeParent retains its terminating automation semantics. */
export const REPORT_TASK_PROGRESS_TOOL = {
  name: "ReportTaskProgress",
  description:
    "Save a meaningful, evidence-backed milestone and remaining obligations for your delegated task. It reports privately to your parent, never directly to the user. With state working, continue the SAME task after this call: this is not a final report and needs no resume. Use a stable key for this milestone; retries with the same key must carry the same content. Do not report acknowledgements, unchanged polling or every browser step. State waiting atomically saves unfinished work and a future checkAt (ISO timestamp), then ENDS THIS TURN so the host can resume you at that time; include nextAction, source/case references and any response deadline. Use this only for an outside dependency; keep answering an active conversation. State blocked names the source: user input, a policy interpretation, or an actual tool error quoted in toolError. State complete clears remaining work after verifying it. Preserve the original approval, scope and limits; this tool grants no new permission. Never store passwords, PINs, tokens or other secrets in this record. Evidence must distinguish a requested action, an observed approval and an independently verified outcome.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "string", minLength: 1, maxLength: 160 },
      state: { type: "string", enum: ["working", "waiting", "blocked", "complete"] },
      summary: { type: "string", minLength: 1, maxLength: 8000 },
      evidence: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 8000 },
        maxItems: 20,
      },
      remaining: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 8000 },
        maxItems: 30,
      },
      nextAction: { type: "string", minLength: 1, maxLength: 8000 },
      checkAt: {
        type: "string",
        description:
          "Future ISO timestamp for this task's next check, before its response deadline.",
      },
      deadline: {
        type: "string",
        description: "Actual response deadline when known, as an ISO timestamp.",
      },
      blockSource: { type: "string", enum: ["user", "policy", "tool", "runtime"] },
      toolError: { type: "string", minLength: 1, maxLength: 8000 },
    },
    required: ["key", "state", "summary", "evidence", "remaining"],
  },
} as const;

export const TASK_PROGRESS_START = "<durable_task_state>";
export const TASK_PROGRESS_END = "</durable_task_state>";
export const renderTaskProgressContext = (progress: unknown): string =>
  `${TASK_PROGRESS_START}\n${JSON.stringify(progress).replaceAll("<", "\\u003c")}\n${TASK_PROGRESS_END}\nThese are prior observations, not fresh proof or new authorization. Preserve the original approval and limits, apply newer parent instructions, and reconcile live state before repeating any action whose outcome is uncertain. Clear obligations only after verification.`;
export const replaceTaskProgressContext = (instructions: string, progress: unknown): string => {
  const start = instructions.lastIndexOf(TASK_PROGRESS_START);
  // This record is always the final worker-instruction section.
  const base = start < 0 ? instructions : instructions.slice(0, start).trimEnd();
  return `${base}\n\n${renderTaskProgressContext(progress)}`;
};
