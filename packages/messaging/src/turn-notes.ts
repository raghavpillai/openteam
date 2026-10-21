/** Per-turn notes ride in one <system_reminder> part ahead of the timestamped query, as in the reference. */
export const USER_REPLY_REMINDER =
  "Reply to this message by actually invoking the SendToUser tool. Make a real tool/function call, not text you write. Plain assistant text is NEVER delivered; only a real SendToUser tool invocation reaches the user, so if you don't invoke the tool they just see silence.";

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
export const turnOwesReplyReminder = (origin: string, content: string): boolean =>
  origin === "user" && !content.startsWith("[SAND_HIDDEN_PROMPT]");

export const withTurnSystemReminder = (reminder: string | null, content: string): string =>
  reminder ? `${reminder}\n${content}` : content;
