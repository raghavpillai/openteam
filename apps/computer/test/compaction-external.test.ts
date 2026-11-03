import { expect, test } from "bun:test";
import {
  buildExternalSummaryPrompt,
  externalDurableBlocks,
  externalPromptChars,
  externalSummaryMessage,
  partitionForExternalSummary,
  reduceExternalPromptChars,
  serializeForExternalSummary,
} from "../src/compaction/external";
import { botUserInfoMessage, type BotMessage } from "../src/bot-compaction";

const text = (role: string, content: string): BotMessage => ({ role, content });

test("the transcript renders calls and results the way the reference flattens them", () => {
  expect(serializeForExternalSummary({ role: "assistant", content: [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "Checking." },
    { type: "toolCall", id: "c", name: "Read", arguments: { path: "/a" } },
  ] })).toBe('assistant: [Thinking] plan\n\nChecking.\n\n[Tool call] Read {"path":"/a"}');
  expect(serializeForExternalSummary({ role: "toolResult", toolName: "Read", content: [{ type: "text", text: "line" }, { type: "image" }] }))
    .toBe('tool: [Tool result] Read "line\\n[Image]"');
  const long = serializeForExternalSummary({ role: "assistant", content: [{ type: "toolCall", name: "Shell", arguments: { command: "x".repeat(100_010) } }] });
  expect(long.endsWith(`\n[... truncated, ${JSON.stringify({ command: "x".repeat(100_010) }).length} total chars]`)).toBe(true);
});

test("the request and everything after it stay verbatim unless that tail fills the window", () => {
  const userInfo = botUserInfoMessage("<user_info>x</user_info>", 0);
  const messages = [userInfo, text("user", "goal"), text("assistant", "a"), text("user", "latest"), text("assistant", "working")];
  const partition = partitionForExternalSummary(messages, 100_000)!;
  expect(partition.userInfoMessage).toEqual(userInfo);
  expect(partition.tailStart).toBe(3);
  expect(partition.messagesToSummarize.map((message) => message.content)).toEqual(["goal", "a", "latest"]);
  expect(partition.requestAfterSummary).toBeNull();
  // A tail as large as the window is summarized too; the request comes back after the summary.
  const huge = partitionForExternalSummary([...messages, text("assistant", "y".repeat(400_000))], 50_000)!;
  expect(huge.tailStart).toBe(6);
  expect(huge.requestAfterSummary?.content).toBe("latest");
});

test("over budget, each message keeps a fair share and the request text survives", () => {
  const messages = [text("user", `<user_query>\nkeep me\n</user_query>${"u".repeat(40_000)}`), text("assistant", "a".repeat(40_000)), text("assistant", "short")];
  const full = buildExternalSummaryPrompt(messages, { budget: 1_000_000 });
  expect(full).toStartWith("user: <user_query>");
  expect(full).toContain("\n<summarization_request>What you see above is the conversation so far");
  expect(full).not.toContain("subscription");
  const cut = buildExternalSummaryPrompt(messages, { budget: 30_000, shorter: true });
  expect(cut.length).toBeLessThanOrEqual(30_000);
  expect(cut).toContain("<user_query>\nkeep me\n</user_query>\n[... truncated,");
  expect(cut).toContain("assistant: short");
  expect(cut).toContain("Additional instruction: Write a shorter summary");
  expect(reduceExternalPromptChars(1_000_000, 1, 800_000)).toBe(500_000);
  expect(reduceExternalPromptChars(1_000_000, 2)).toBe(333_333);
  expect(reduceExternalPromptChars(60_000, 2)).toBe(50_000);
  expect(externalPromptChars(200_000, 32_000)).toBe(498_000);
  expect(externalPromptChars(2_000_000, 32_000)).toBe(2_800_000);
});

test("the carrier is the reference's previous-summary message with OpenTeam's durable blocks", () => {
  const blocks = externalDurableBlocks([text("user", "<manually_attached_skills>A</manually_attached_skills>")], {
    transcriptPath: "/private", todoUpdate: "- **PENDING**: x (id: 1)", isRootProject: true, projectRoot: "/w",
  });
  expect(blocks[0]).toStartWith("### Transcript location:\n  This is the full transcript of your past conversation");
  expect(blocks.slice(1)).toEqual([
    "<system_reminder>Project root: /w</system_reminder>",
    "NOTE: There was an active todo list in the conversation. Here is the latest update before summarization:\n<todo_update>\n- **PENDING**: x (id: 1)\n</todo_update>",
    "<manually_attached_skills>A</manually_attached_skills>",
  ]);
  const carrier = externalSummaryMessage("Done so far.", blocks.slice(3), 5);
  expect(carrier).toEqual({
    role: "user",
    content: [{ type: "text", text: "[Previous conversation summary]: Done so far.\n\n<manually_attached_skills>A</manually_attached_skills>" }],
    timestamp: 5,
    providerOptions: { cursor: { isSummary: true } },
  });
});
