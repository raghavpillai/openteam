import type { Prisma } from "@openteam/db";

// A background task started inside a routine reports back to that routine, which nobody is waiting on.
export const QUIET_REVIVAL_INSTRUCTION =
  'Pick the work back up. Everything above came out of your own quiet routine(s). The user did not ask to hear about it, so the saved instruction\'s delivery rule governs. If the outcome is a genuine change, a new actionable result, or a real blocker the user must know about, tell them once with a single useful SendToUser. If it amounts to no change, nothing new, or still waiting, end the turn with no SendToUser at all and no "still waiting" or progress notes; if the routine says to keep watching, just keep the watch going quietly. Keep your status current, and clear it once everything is done and you\'re idle. Never message the user just to say that nothing has changed.';

export const quietRoutineOriginNote = (routine: { name: string; folder: string }): string =>
  `(You started this during your routine "${routine.name}" (folder ${routine.folder}), and nobody is waiting on it.)`;

/** The routine whose automation context a background result resumes. */
export const automationContextRoutine = async (tx: Prisma.TransactionClient, automationContextRunId: string) => {
  const routine = (await tx.routineExecution.findUnique({
    where: { runId: automationContextRunId },
    select: { routine: { select: { name: true, slug: true } } },
  }))?.routine;
  return routine ? { name: routine.name, folder: routine.slug } : undefined;
};

/** The revival of a task a routine started, with the reference's origin note and quiet instruction. */
export const renderQuietSubagentRevivalPrompt = (input: {
  title: string;
  subagentType: string;
  status: "completed" | "failed";
  result: string;
  routine: { name: string; folder: string };
}): string =>
  [
    "[A background task just completed] A background task you started has finished.",
    "",
    `Background task "${input.title}" (${input.subagentType}) ${input.status === "completed" ? "finished" : "failed"}:`,
    input.result.trim(),
    quietRoutineOriginNote(input.routine),
    "",
    QUIET_REVIVAL_INSTRUCTION,
  ].join("\n");

/**
 * Results of a routine's background work, delivered to the routine in one turn once none of
 * that work is still running, as the reference's automation runs drain theirs. Each block
 * carries its origin note; a routine's results are never marked as held.
 */
export const renderQuietRevivalBatchPrompt = (blocks: readonly string[]): string =>
  [
    `[SAND_HIDDEN_PROMPT][A background task just completed] ${blocks.length === 1 ? "A background task you started has finished." : `${blocks.length} background tasks you started have finished.`}`,
    "",
    blocks.join("\n\n"),
    "",
    QUIET_REVIVAL_INSTRUCTION,
  ].join("\n");
