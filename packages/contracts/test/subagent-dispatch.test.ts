import { expect, test } from "bun:test";
import {
  canonicalSubagentType,
  parentOnlyDispatchNotice,
  parentOnlyToolsFor,
  subagentTitle,
  withCanonicalSubagentType,
  withSiteDispatchNotes,
  withoutSiteDispatchNotes,
} from "../src/subagent-dispatch";

const PROMPT =
  "Research the flights, then UpdateMemory with the preference, SendToUser the summary, call DraftExternalMessage for the email, and UpdateRoutine to check daily. Use WebSearch and TodoWrite. Also SendToAgent the result.";

test("a dispatch naming tools the executor lacks tells the parent to do those steps itself", () => {
  expect(parentOnlyDispatchNotice({ subagentType: "executor", prompt: PROMPT })).toBe(
    [
      "<system_reminder>",
      "This dispatch names DraftExternalMessage, SendToAgent, SendToUser, TodoWrite, UpdateMemory, UpdateRoutine, which the executor subagent does not have, so it cannot do those steps.",
      "- DraftExternalMessage: Only the parent talks to the user; a Task subagent reports back in its final message.",
      "- SendToAgent: Messages under the user's name need approval that only the parent can collect.",
      "- SendToUser: Only the parent talks to the user; a Task subagent reports back in its final message.",
      "- TodoWrite: Task subagents don't start subagents of their own; the parent fans work out.",
      "- UpdateMemory: Memory, routines, tasks, and the bot's profile change only through the parent, which owns the conversation.",
      "- UpdateRoutine: Memory, routines, tasks, and the bot's profile change only through the parent, which owns the conversation.",
      "If the task needs them, do those steps yourself in this turn, before you end it. The subagent still runs and reports back on the rest.",
      "</system_reminder>",
    ].join("\n")
  );
});

test("each worker type gets its own reasons, and a resume names only what every type lacks", () => {
  const computerUse = parentOnlyDispatchNotice({ subagentType: "computer_use", prompt: PROMPT })!;
  expect(computerUse).toContain("which the computerUse subagent does not have");
  expect(computerUse).toContain("- SendToUser: computerUse reports to the parent that dispatched it, never to the user.");
  expect(computerUse).toContain("- WebSearch: computerUse browses in the box browser it drives; search and fetch belong to the parent.");
  expect(computerUse).toContain("- UpdateMemory: Memory, routines, tasks, and the bot's profile change only through the parent.\n");
  expect(parentOnlyDispatchNotice({ subagentType: "executor", prompt: PROMPT })).not.toContain("WebSearch");
  expect(parentOnlyDispatchNotice({ subagentType: "videoReview", prompt: "WebSearch it" })).toContain(
    "- WebSearch: Media review is a single review pass over the media it is handed and holds no tools."
  );
  const resumed = parentOnlyDispatchNotice({ subagentType: undefined, prompt: `${PROMPT} RequestUserForm` })!;
  expect(resumed).toContain("which the resumed subagent does not have");
  expect(resumed).not.toContain("WebSearch");
  // computerUse may hold the in-chat form in the reference, so a resume never names it.
  expect(resumed).not.toContain("RequestUserForm");
  expect(parentOnlyToolsFor("knowledgeWork")).toEqual(parentOnlyToolsFor("executor"));
});

test("only whole tool names count, and tools the child has are never named", () => {
  expect(parentOnlyDispatchNotice({ subagentType: "executor", prompt: "Shell out, Read the file, WebFetch the page, then UploadFile it." })).toBeUndefined();
  expect(parentOnlyDispatchNotice({ subagentType: "executor", prompt: "Write MySendToUser and SendToUsers helpers." })).toBeUndefined();
  expect(parentOnlyDispatchNotice({ subagentType: "executor", prompt: "Answer (SendToUser)." })).toContain("- SendToUser:");
});

test("a computerUse task naming OpenTable or Resy carries the site notes once", () => {
  const task = "Check open tables for 2 on OpenTable at https://www.opentable.com/r/x?covers=2 tonight.";
  const noted = withSiteDispatchNotes(task);
  expect(noted).toStartWith(`${task}\n\nOpenTable notes, for checking open tables or booking on OpenTable.`);
  expect(noted).toContain("On an availability check, never click a time, because that holds the table.");
  expect(withSiteDispatchNotes(noted)).toBe(noted);
  expect(withSiteDispatchNotes("Book on resy.com")).toContain("Resy notes, for checking open tables or booking on Resy.");
  expect(withSiteDispatchNotes("Find a good espresso place")).toBe("Find a good espresso place");
  expect(withoutSiteDispatchNotes(noted).trim()).toBe(task);
});

test("a background task's title is the opening of the parent's own words", () => {
  expect(subagentTitle("  Find the three cheapest\n nonstop flights  ")).toBe("Find the three cheapest nonstop flights");
  const long = "Find the three cheapest nonstop flights from SFO to JFK on Nov 3 and report airline, times and fares.";
  expect(subagentTitle(long)).toBe(`${long.slice(0, 79)}…`);
  expect(subagentTitle(long)).toHaveLength(80);
  expect(subagentTitle(withSiteDispatchNotes("Check Resy for two tonight"))).toBe("Check Resy for two tonight");
  expect(subagentTitle("Plugin template\n\nPackage files: /x\n\nBody\n\nTask from the parent:\nSummarize the repo")).toBe("Summarize the repo");
  expect(subagentTitle(" \n ")).toBe("Background task");
});

test("subagent_type spellings name the type they mean", () => {
  for (const [spelling, type] of [
    ["computer_use", "computerUse"], ["ComputerUse", "computerUse"], ["computerUseAgent", "computerUse"],
    ["executor_agent", "executor"], ["mediaReview", "videoReview"], ["watch-video", "watchVideo"], ["knowledge_work", "knowledgeWork"],
  ])
    expect(canonicalSubagentType(spelling!), spelling).toBe(type!);
  expect(canonicalSubagentType("browser")).toBe("browser");
  expect(withCanonicalSubagentType({ prompt: "x", subagent_type: "computer_use" })).toEqual({ prompt: "x", subagent_type: "computerUse" });
});
