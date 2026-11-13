import { describe, expect, test } from "bun:test";
import {
  buildGroupTurnPrompt,
  directAgentWake,
  normalizeGroupAgentMessage,
  renderRevivalBatchPrompt,
  shellCompletionBlock,
  subagentRevivalBlock,
} from "../src";
import { eventRoutineWakeContent, manualRoutineWakeContent, scheduledRoutineWakeContent } from "../src/routines";

// Hidden wakes must start with the marker the runtime uses to keep them out of the user's transcript.
const HIDDEN = "[SAND_HIDDEN_PROMPT]";

describe("agent-to-agent messages", () => {
  test.each([
    [" \n\t ", { status: "empty", content: "" }],
    ...["PASS", "( pass )."].map((pass) => [`  ${pass}  `, { status: "pass", content: "" }] as const),
    ["(pass) — revised answer", { status: "message", content: "revised answer" }],
    [`  ${"x".repeat(8_005)}  `, { status: "message", content: "x".repeat(8_000) }],
  ] as const)("group message %#", (input, expected) => {
    expect(normalizeGroupAgentMessage(input)).toEqual(expected);
  });

  test("a direct wake is hidden, names the sender's id, and lists attached images", () => {
    const wake = directAgentWake({
      senderId: "agent-1", senderName: "Planner", message: "Review this.", priority: false, interrupted: false,
      images: [{ url: "file:///tmp/shot.png", alt: "  Status\nchart  " }],
    });
    expect(wake).toStartWith(`${HIDDEN}[agent] A message just arrived from another of your user's agents: Planner (id: agent-1).`);
    expect(wake).toContain("\n\nPlanner: Review this.\n\n");
    expect(wake).toContain("- file:///tmp/shot.png — Status chart");
  });

  test("a group turn lists the room, labels speakers and caps reply quotes", () => {
    const prompt = buildGroupTurnPrompt({
      groupName: "Testing", targetId: "self", targetName: "Self",
      members: [{ id: "self", name: "Self" }, { id: "peer", name: "Peer", description: "Works with Workspace." }],
      messages: [
        { sender: "user", senderName: "Raghav", content: "Question" },
        { sender: "agent", senderId: "self", senderName: "Self", content: "Earlier" },
        { sender: "agent", senderId: "peer", senderName: "Peer", content: "Reply", reply: { sender: "user", senderName: "Raghav", content: `  ${"x".repeat(8_100)}  ` } },
      ],
    });
    expect(prompt).toStartWith('[Group chat: "Testing" - with Peer]\nParticipants: Peer (Works with Workspace.)');
    expect(prompt).toContain("Raghav (user): Question");
    expect(prompt).toContain("Self (you): Earlier");
    expect(prompt).toContain(`Peer: [in reply to Raghav (user): ${JSON.stringify("x".repeat(8_000))}] Reply`);
    expect(prompt).toContain("It's your turn, Self.");
    expect(buildGroupTurnPrompt({
      groupName: "Files", roomDescription: "  Production launch triage  ", targetId: "one", targetName: "One",
      members: [{ id: "one", name: "One" }], messages: [{ sender: "user", content: "", hasImages: true }],
    })).toContain('[Group chat: "Files"]\nRoom: Production launch triage\nThe user shared attachments with the room.');
  });
});

describe("background completion wakes", () => {
  test("completions ready together are batched, and late ones say how long they waited", () => {
    const report = subagentRevivalBlock({ title: "Find flights", subagentType: "executor", status: "completed", result: "Two nonstops found.\n" });
    // A host shell's output lives on its machine, so the wake must name it.
    const shell = shellCompletionBlock({ id: "x", hostShellId: "9", machineId: "mac", scope: "bot", outputPath: "/h/9.log", exitCode: 2, title: "npm test" });
    expect(shell).toContain('machineId "mac"');
    expect(report).toBe('Background task "Find flights" (executor) finished:\nTwo nonstops found.');
    const batch = renderRevivalBatchPrompt([
      { block: report, subagentType: "executor" },
      { block: shell, subagentType: "shell", heldForMs: 7 * 60_000 + 10_000 },
    ]);
    expect(batch).toStartWith(`${HIDDEN}[A background task just completed] 2 background tasks you started have finished.`);
    expect(batch.indexOf(report)).toBeLessThan(batch.indexOf(shell));
    expect(batch).toContain(`${shell}\n(This finished about 7 minutes ago and reached you only now`);
    const room = 'This work belongs to group room "Launch".';
    const single = renderRevivalBatchPrompt([{ block: report, subagentType: "executor", note: room, heldForMs: 2 * 3_600_000 }]);
    expect(single).toContain("A background task you started has finished.\n");
    expect(single).toContain("about 2 hours ago");
    expect(single).toEndWith(`\n\n${room}`);
  });
});

describe("routine wakes", () => {
  test("a scheduled wake is hidden, describes its schedule and fire time in the routine's zone", () => {
    const daily = scheduledRoutineWakeContent({
      name: "Daily audit", folder: "daily-audit", schedule: "0 0 * * *",
      scheduledFor: new Date("2026-08-28T11:00:00.000Z"), prompt: "Inspect the queue.",
    });
    expect(daily).toStartWith(`${HIDDEN}[routine] "Daily audit" (folder daily-audit) is due. Trigger: Every day at 12:00 AM (0 0 * * *), fired 8/28/2026, 11:00:00 AM UTC.`);
    expect(daily).toContain("\nInspect the queue.\n");
    const dated = scheduledRoutineWakeContent({
      name: "Support check", folder: "support-check", schedule: "10 13 18 10 *",
      scheduledFor: new Date("2026-10-18T20:10:00.000Z"), timeZone: "America/Los_Angeles", prompt: "Check.",
    });
    expect(dated).toMatch(/Trigger: Once October 18 at 1:10 PM \(10 13 18 10 \*\), fired 10\/18\/2026, 1:10:00\sPM PDT\./);
    const wake = (schedule: string) => scheduledRoutineWakeContent({ name: "W", folder: "w", schedule, scheduledFor: new Date("2026-10-18T13:10:00.000Z"), prompt: "Check." });
    expect(wake("10 13 31 2 *")).not.toContain("Once February 31");
  });

  test("a Run now wake from the user is trusted", () => {
    expect(manualRoutineWakeContent({
      name: "Daily audit", folder: "daily-audit", schedule: "0 0 * * *",
      firedAt: new Date("2026-08-28T11:00:00.000Z"), prompt: "Inspect the queue.", provenance: "user",
    })).toStartWith(`${HIDDEN}[SAND_TRUSTED_AUTOMATION_PROMPT][routine] "Daily audit" (folder daily-audit) was run on demand.`);
  });

  test("an event wake leads with the event, coalescing several under the newest", () => {
    const event = (id: string, text: string) => ({ id, source: "slack" as const, kind: "message", text, channel: "#support", actor: "Dana" });
    const wake = (events: ReturnType<typeof event>[]) => eventRoutineWakeContent({
      name: "Support replies", folder: "support-replies", schedule: "Event: slack",
      trigger: { type: "slack", channel: "#support", match: { kind: "message" } },
      firedAt: new Date("2026-10-23T15:00:00.000Z"), timeZone: "America/New_York",
      prompt: "Summarize the reply for the user.", provenance: "user", events,
    });
    const one = wake([event("e1", "The refund went through")]);
    expect(one).toContain('What woke you: Dana in #support: "The refund went through"\n<slack_message>');
    expect(one.indexOf("<slack_message>")).toBeLessThan(one.indexOf("Summarize the reply for the user."));
    const two = wake([event("e1", "First reply"), event("e2", "Second reply")]);
    expect(two).toContain('What woke you: 2 events; latest: Dana in #support: "Second reply"');
    expect(two.split("<slack_message>").length - 1).toBe(2);
    expect(two.split("What woke you:").length - 1).toBe(1);
  });
});
