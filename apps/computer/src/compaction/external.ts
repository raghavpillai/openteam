import type { BotMessage } from "./types";
import { imageParts, isInjectedReminder, isSummary, isUserInfo, messageText, xmlText } from "./messages";

/** Context-overflow recovery, as the reference's external summarizer: a flattened, size-capped
 * transcript goes to the model with its own prompt, and the in-progress request stays verbatim. */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are an intelligent assistant, tasked with summarizing the following conversation. You MUST follow the instructions given in the <summarization_request> tags and summarize the conversation. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation.`;

// Reference MORE_PROMPT, verbatim except item 10 (event subscriptions): OpenTeam has no subscribe tools.
export const EXTERNAL_SUMMARY_REQUEST = `What you see above is the conversation so far, rendered as a transcript. Previous user messages, previous assistant messages, and tool calls are shown in tags, while the original system prompt has been removed. The content in the tags has been rendered exactly as it was in the original conversation.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation above. So you should NEVER refer to summarization in your summary, just an output that could be used to continue the task.

This summary should be thorough in capturing technical details, code patterns, and architectural decisions
that would be essential for continuing development work without losing context.

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
   - file names
   - full code snippets
   - function signatures
   - file edits
- Errors that you ran into and how you fixed them
- Pay special attention to specific user feedback that you received, especially if the user told you to do
something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results or subagent prompts/results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed.

If there is a next step, include direct quotes from the most recent conversation
showing exactly what task you were working on and where you left off. This should be verbatim to ensure
there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
Summary:
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
   - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
   - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
   - [Detailed non tool use, non subagent user message]
   - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const SHORTER_OUTPUT_RETRY_PROMPT = `

Additional instruction: Write a shorter summary that focuses on the highest-signal context. Avoid long code snippets and avoid unnecessarily exhaustive detail. Prioritize the most recent user intent, recent implementation work, and unresolved blockers.
IMPORTANT: When listing user messages, you do not need to repeat each message verbatim. Concisely capture user intent.`;

export const PREVIOUS_CONVERSATION_SUMMARY_PREFIX = "[Previous conversation summary]:";
export const EXTERNAL_SUMMARY_MAX_OUTPUT_TOKENS = 32_000;
export const MAX_EXTERNAL_PROMPT_CHARS = 2_800_000;
export const MIN_EXTERNAL_PROMPT_CHARS = 50_000;
const MAX_PROMPT_BYTES = 9 * 1024 * 1024;
const MAX_TOOL_CONTENT_PART_CHARS = 100_000;
const MIN_USEFUL_CHARS = 200;

/** A prompt budget that leaves room for the summary in the model's own window (about 3 characters a token). */
export const externalPromptChars = (contextWindow: number, outputTokens: number): number =>
  Math.max(8_000, Math.min(MAX_EXTERNAL_PROMPT_CHARS, Math.floor((contextWindow - outputTokens - 2_000) * 3)));

export const externalOutputTokens = (contextWindow: number, modelMaxTokens: number): number =>
  Math.max(1, Math.min(EXTERNAL_SUMMARY_MAX_OUTPUT_TOKENS, modelMaxTokens || EXTERNAL_SUMMARY_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4)));

const guarded = (prefix: string, value: string) =>
  value.length > MAX_TOOL_CONTENT_PART_CHARS
    ? `${prefix} ${value.slice(0, MAX_TOOL_CONTENT_PART_CHARS)}\n[... truncated, ${value.length} total chars]`
    : `${prefix} ${value}`;

const ROLES: Record<string, string> = { toolResult: "tool", tool: "tool", custom: "user" };

/** `role: content`, with calls and results as `[Tool call] name {json}` and `[Tool result] name {json}`. */
export function serializeForExternalSummary(message: BotMessage): string {
  const role = ROLES[String(message.role)] ?? String(message.role);
  if (message.role === "toolResult" || message.role === "tool") {
    const parts = Array.isArray(message.content) ? message.content : [message.content];
    const text = parts.map((part: any) => typeof part === "string" ? part : part?.type === "image" ? "[Image]" : part?.text ?? "").join("\n");
    return `${role}: ${guarded(`[Tool result] ${String(message.toolName ?? "tool")}`, JSON.stringify(text) ?? "null")}`;
  }
  if (!Array.isArray(message.content)) return `${role}: ${typeof message.content === "string" ? message.content : messageText(message)}`;
  const body = message.content.map((part: any) => {
    if (part?.type === "text") return part.text;
    if (part?.type === "image" || part?.type === "image_url") return "[Image]";
    if (part?.type === "thinking") return `[Thinking] ${part.thinking ?? ""}`;
    if (part?.type === "toolCall") return guarded(`[Tool call] ${part.name}`, JSON.stringify(part.arguments) ?? "null");
    return "";
  }).join("\n\n");
  return `${role}: ${body}`;
}

const isRequestMessage = (message: BotMessage) =>
  message.role === "user" && !isSummary(message) && !isInjectedReminder(message) && !isUserInfo(message);

export interface ExternalPartition {
  userInfoMessage: BotMessage | null;
  messagesToSummarize: BotMessage[];
  /** Index in the input where the verbatim tail starts (the last request), or the input length. */
  tailStart: number;
  /** A request repeated after the summary when nothing else of the tail survives. */
  requestAfterSummary: BotMessage | null;
  lastUserMessage: BotMessage;
}

/** Keep the last request and everything after it verbatim unless that tail alone fills the window. */
export function partitionForExternalSummary(messages: readonly BotMessage[], contextWindow: number): ExternalPartition | null {
  const userInfoIndex = messages[0] && isUserInfo(messages[0]) ? 0 : -1;
  const offset = userInfoIndex + 1;
  const body = messages.slice(offset).filter((message) => message.role !== "system");
  if (body.length === 0) return null;
  let split = body.findLastIndex(isRequestMessage);
  const tail = body.slice(Math.max(split, 0));
  // A cheap size check, like the reference's: about 4 characters a token, images at a flat rate.
  const tailTokens = tail.reduce(
    (total, message) => total + Math.ceil(serializeForExternalSummary(message).length / 4) + imageParts(message.content) * 1_200,
    0
  );
  if (split <= 1 || body.slice(split + 1).some(isSummary) || (tail.length > 1 && contextWindow > 0 && tailTokens >= contextWindow))
    split = body.length;
  const messagesToSummarize = structuredClone(body.slice(0, split + 1));
  let requestAfterSummary: BotMessage | null = null;
  if (split === body.length) {
    const request = messagesToSummarize.findLastIndex(isRequestMessage);
    if (request !== -1 && request !== messagesToSummarize.length - 1) requestAfterSummary = structuredClone(messagesToSummarize[request]!);
  }
  const lastUser = body.findLast(isRequestMessage) ?? body[0]!;
  return {
    userInfoMessage: userInfoIndex === 0 ? structuredClone(messages[0]!) : null,
    messagesToSummarize,
    tailStart: split + offset,
    requestAfterSummary,
    lastUserMessage: structuredClone(lastUser),
  };
}

const omittedPreamble = (count: number) =>
  `[${count} message(s) omitted due to size limits; omitted content may appear anywhere in the conversation. See transcript file for full history.]\n\n`;

const fairAllocations = (sizes: readonly number[], budget: number): number[] => {
  const allocations = new Array<number>(sizes.length).fill(0);
  let remaining = budget;
  let count = sizes.length;
  for (const { size, index } of sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size)) {
    const share = Math.floor(remaining / count);
    allocations[index] = Math.min(size, share);
    remaining -= allocations[index]!;
    count--;
  }
  return allocations;
};

const keepUserQuery = (entry: string, max: number): string => {
  const blocks = [...entry.matchAll(/<user_query>[\s\S]*?<\/user_query>/g)].map((match) => match[0]).join("\n");
  if (!blocks) return entry.slice(0, max);
  if (blocks.length >= max) return blocks.slice(0, max);
  const rest = entry.replace(/<user_query>[\s\S]*?<\/user_query>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!rest) return blocks;
  const budget = max - blocks.length - 1;
  return budget <= 0 ? blocks : `${rest.slice(0, budget)}\n${blocks}`;
};

export class CannotTruncatePromptError extends Error {
  constructor() {
    super("Cannot fit any summarization message within prompt char budget");
    this.name = "CannotTruncatePromptError";
  }
}

/** The transcript plus the request; over budget, every message gets a max-min fair share. */
export function buildExternalSummaryPrompt(messages: readonly BotMessage[], options: { budget: number; shorter?: boolean }): string {
  const serialized = messages.map(serializeForExternalSummary);
  const suffix = `\n<summarization_request>${EXTERNAL_SUMMARY_REQUEST}${options.shorter ? SHORTER_OUTPUT_RETRY_PROMPT : ""}</summarization_request>`;
  const full = serialized.join("\n\n") + suffix;
  let budget = options.budget;
  const bytes = Buffer.byteLength(full, "utf-8");
  if (bytes > MAX_PROMPT_BYTES) {
    const perChar = bytes / full.length;
    if (perChar > (MAX_PROMPT_BYTES / budget) * 0.95) budget = Math.floor((MAX_PROMPT_BYTES / perChar) * 0.8);
  }
  if (full.length <= budget) return full;
  const separators = Math.max(0, serialized.length - 1) * 2;
  const content = Math.max(0, budget - suffix.length - separators - omittedPreamble(serialized.length).length);
  const allocations = fairAllocations(serialized.map((entry) => entry.length), content);
  let dropped = 0;
  let kept = 0;
  const parts = serialized.map((entry, index) => {
    const allocation = allocations[index] ?? 0;
    const role = ROLES[String(messages[index]?.role)] ?? String(messages[index]?.role);
    if (allocation >= entry.length) {
      kept++;
      return entry;
    }
    if (allocation < MIN_USEFUL_CHARS) {
      dropped++;
      return `[omitted ${role} message, ${entry.length} chars]`;
    }
    kept++;
    const note = `\n[... truncated, ${entry.length} chars]`;
    const room = Math.max(0, allocation - note.length);
    return (role === "user" ? keepUserQuery(entry, room) : entry.slice(0, room)) + note;
  });
  if (kept === 0) throw new CannotTruncatePromptError();
  return (dropped > 0 ? omittedPreamble(dropped) : "") + parts.join("\n\n") + suffix;
}

/** After an input-limit failure: a half, then a third, never above 75% of what failed. */
export const reduceExternalPromptChars = (current: number, attempt: number, failedLength?: number): number => {
  let next = Math.floor(current / (attempt >= 2 ? 3 : 2));
  if (failedLength !== undefined) next = Math.min(next, Math.floor(failedLength * 0.75));
  return Math.max(MIN_EXTERNAL_PROMPT_CHARS, next);
};

// The reference's markdown transcript block, adapted like TRANSCRIPT_LOCATION: the session file is private.
const EXTERNAL_TRANSCRIPT_LOCATION = `### Transcript location:
  This is the full transcript of your past conversation with the user (pre- and post-summary): read it with cursor.ReadTranscript and no id.

  If anything about the task or current state is unclear (missing context, ambiguous requirements, uncertain decisions, exact wording, IDs/paths, errors/logs), you should consult this transcript.

  How to use it:
  - It returns the newest messages first; page back with \`before\` until you reach the part you need (task name, filenames, IDs, errors, tool names).
  - Then read a small window around it to reconstruct intent and state.
  - Avoid reading linearly end-to-end; the transcript can be very large and some single entries can be huge.
  - It contains one structured json event per entry, including user/assistant messages, tool calls and tool results.`;

/** External carriers list transcript, project root, todos and attached skills after the summary. */
export function externalDurableBlocks(
  messagesToSummarize: readonly BotMessage[],
  context: { projectRoot?: string; isRootProject?: boolean; transcriptPath?: string; todoUpdate?: string }
): string[] {
  const skills = messagesToSummarize
    .filter((message) => message.role === "user")
    .flatMap((message) => Array.from(messageText(message).matchAll(/<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/g), (match) => match[0].trim()));
  return [
    ...(context.transcriptPath ? [EXTERNAL_TRANSCRIPT_LOCATION] : []),
    ...(context.isRootProject && context.projectRoot ? [`<system_reminder>Project root: ${xmlText(context.projectRoot)}</system_reminder>`] : []),
    ...(context.todoUpdate
      ? [`NOTE: There was an active todo list in the conversation. Here is the latest update before summarization:\n<todo_update>\n${context.todoUpdate}\n</todo_update>`]
      : []),
    ...[...new Set(skills)],
  ];
}

export const externalSummaryMessage = (summary: string, durableBlocks: readonly string[], timestamp = Date.now()): BotMessage => ({
  role: "user",
  content: [{ type: "text", text: `${PREVIOUS_CONVERSATION_SUMMARY_PREFIX} ${summary}${durableBlocks.map((block) => `\n\n${block}`).join("")}` }],
  timestamp,
  providerOptions: { cursor: { isSummary: true } },
});
