/** Per-turn notes ride in one <system_reminder> part ahead of the timestamped query, as in the reference. */
export const USER_REPLY_REMINDER =
  "Respond with an actual SendToUser call when the user needs words, or one suitable ReactToMessage tapback when acknowledgement alone is enough. Plain assistant text is private and never delivered. For simple thanks, agreement, jokes, or good news, prefer a reaction if words add nothing. A brief instruction update while requested work is already running can also get a tapback without a redundant text acknowledgement. Use end_turn only when you are done for now; otherwise keep working. Deliver requested answers and results with SendToUser, and use words for a new substantial task, a question, a blocker, or emotional support. Respect requests for no emoji or reactions.";

export const UNFINISHED_TASKS_REMINDER =
  "The user interrupted your work to send you a message. Follow the new message first. Complete any unfinished tasks from previous turns unless the user asked you to stop, halt, cancel, quit working, or otherwise end the work; in that case, do not continue or resume those tasks.";

const OPEN = "<system_reminder>\n";
const CLOSE = "\n</system_reminder>";

/** A note that is already one whole reminder block joins the shared block as its body. */
export const unwrapSystemReminder = (block: string): string => {
  if (!block.startsWith(OPEN) || !block.endsWith(CLOSE)) return block;
  const body = block.slice(OPEN.length, -CLOSE.length);
  return body.includes("<system_reminder>") ? block : body;
};

export const turnSystemReminder = (
  notes: ReadonlyArray<string | null | undefined>,
  options: { unfinishedTasks?: boolean; reply?: boolean } = {}
): string | null => {
  const body = [
    ...notes.flatMap((note) => (note ? [unwrapSystemReminder(note.trim())] : [])),
    ...(options.unfinishedTasks ? [UNFINISHED_TASKS_REMINDER] : []),
    ...(options.reply ? [USER_REPLY_REMINDER] : []),
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");
  return body ? `${OPEN}${body}${CLOSE}` : null;
};

/** Only a typed, visible user message is owed the reply reminder; hidden host prompts are not. */
export const turnOwesReplyReminder = (origin: string, content: string, inboxType?: string): boolean => {
  if (origin !== "user" || inboxType === "user.reaction") return false;
  // Legacy callers can lack event metadata. Unwrap only the host's full canonical envelope;
  // an addressed user message quoting a hidden marker still requires a response.
  const query = /^<timestamp>[^<\n]*<\/timestamp>\n<user_query>\n([\s\S]*)\n<\/user_query>$/.exec(content)?.[1] ?? content;
  return !query.startsWith("[SAND_HIDDEN_PROMPT]");
};

export const withTurnSystemReminder = (reminder: string | null, content: string): string =>
  reminder ? `${reminder}\n${content}` : content;
