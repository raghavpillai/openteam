// A background task started inside a routine reports back to that routine, which nobody is waiting on.
export const QUIET_REVIVAL_INSTRUCTION =
  'Pick the work back up. Everything above came out of your own quiet routine(s). The user did not ask to hear about it, so the saved instruction\'s delivery rule governs. If the outcome is a genuine change, a new actionable result, or a real blocker the user must know about, tell them once with a single useful SendToUser. If it amounts to no change, nothing new, or still waiting, end the turn with no SendToUser at all and no "still waiting" or progress notes; if the routine says to keep watching, just keep the watch going quietly. Keep your status current, and clear it once everything is done and you\'re idle. Never message the user just to say that nothing has changed.';

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
    `(You started this during your routine "${input.routine.name}" (folder ${input.routine.folder}), and nobody is waiting on it.)`,
    "",
    QUIET_REVIVAL_INSTRUCTION,
  ].join("\n");
