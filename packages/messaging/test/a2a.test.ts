import { describe, expect, test } from "bun:test";
import {
  A2A_PLATFORM_INSTRUCTIONS,
  buildGroupTurnPrompt,
  clampAgentMessage,
  directAgentAcknowledgement,
  directAgentWake,
  GROUP_MEMBER_TURN_MESSAGE_LIMIT_NOTICE,
  groupAgentAcknowledgement,
  normalizeGroupAgentMessage,
  routineRuntimeStatus,
} from "../src";

describe("agent-to-agent protocol", () => {
  test("returns stable fire-and-forget acknowledgements without internal ids", () => {
    expect(directAgentAcknowledgement({ targetName: "Researcher", priority: false })).toBe(
      "Sent to Researcher. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now."
    );
    expect(directAgentAcknowledgement({ targetName: "Researcher", priority: true })).toBe(
      "Sent to Researcher as a priority message — it will interrupt their current non-user work and wake them now. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now."
    );
    expect(groupAgentAcknowledgement("Launch Room", { imageCount: 1 })).toBe(
      'Posted to "Launch Room". Its members will see it and reply on their own turns. Note: the attached image was NOT delivered — group messages are text-only for now; send images to an agent directly.'
    );
    expect(groupAgentAcknowledgement("Launch Room", { priority: true })).toBe(
      'Posted to "Launch Room". Its members will see it and reply on their own turns.'
    );
    expect(groupAgentAcknowledgement("Launch Room", { imageCount: 2 })).toBe(
      'Posted to "Launch Room". Its members will see it and reply on their own turns. Note: the attached images were NOT delivered — group messages are text-only for now; send images to an agent directly.'
    );
  });

  test("matches OpenTeam's group empty/pass handling and 8,000-character clamp", () => {
    expect(clampAgentMessage(`  ${"x".repeat(8_005)}  `)).toBe("x".repeat(8_000));
    expect(normalizeGroupAgentMessage(" \n\t ")).toEqual({ status: "empty", content: "" });
    for (const pass of ["pass", "PASS", "(pass)", "( pass )."]) {
      expect(normalizeGroupAgentMessage(`  ${pass}  `)).toEqual({ status: "pass", content: "" });
    }
    expect(normalizeGroupAgentMessage(`  ${"x".repeat(8_005)}  `)).toEqual({
      status: "message",
      content: "x".repeat(8_000),
    });
  });

  test("matches OpenTeam's direct-agent wake byte-for-byte when no routines exist", () => {
    const wake = directAgentWake({
      senderId: "fd4b1bd8-d320-4653-a765-95254b1fa570",
      senderName: "Test #2",
      message: 'Reply with exactly: "done"',
      priority: false,
      interrupted: false,
    });
    expect(
      wake
    ).toBe(`[SAND_HIDDEN_PROMPT][agent] A message just arrived from another of your user's agents: Test #2 (id: fd4b1bd8-d320-4653-a765-95254b1fa570).
This is another assistant reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.

Test #2: Reply with exactly: "done"

If it needs a reply or an action, handle it: reply to Test #2 with SendToAgent (their id: fd4b1bd8-d320-4653-a765-95254b1fa570), which reaches them on a later turn — not a live back-and-forth — and use SendToUser to tell your user only when you have a real result to share. If it is just an FYI with nothing for you to do, it is fine to stay silent — no need to reply just to acknowledge it.`);
  });

  test("matches OpenTeam's direct image wake list byte-for-byte", () => {
    expect(
      directAgentWake({
        senderId: "agent-1",
        senderName: "Planner",
        message: "Review this.",
        priority: false,
        interrupted: false,
        images: [{ url: "file:///tmp/shot.png", alt: "  Status\nchart  " }],
      })
    ).toBe(`[SAND_HIDDEN_PROMPT][agent] A message just arrived from another of your user's agents: Planner (id: agent-1).
This is another assistant reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.

Planner: Review this.

Planner attached an image to this message:
- file:///tmp/shot.png — Status chart
Local image files are shown to you alongside this message. To pass one on, re-attach its url in your own SendToUser (images) or SendToAgent (images).

If it needs a reply or an action, handle it: reply to Planner with SendToAgent (their id: agent-1), which reaches them on a later turn — not a live back-and-forth — and use SendToUser to tell your user only when you have a real result to share. If it is just an FYI with nothing for you to do, it is fine to stay silent — no need to reply just to acknowledge it.`);
  });

  test("matches OpenTeam's source-verified group-turn envelope", () => {
    expect(
      buildGroupTurnPrompt({
        groupName: "Testing",
        targetId: "bot",
        targetName: "Bot",
        members: [
          { id: "bot", name: "Bot" },
          { id: "test-2", name: "Test #2" },
        ],
        messages: [
          {
            sender: "user",
            content:
              "Do you guys have access to my chats that i've sent to you? or are you guys just running off memories?",
          },
        ],
      })
    ).toBe(`[Group chat: "Testing" - with Test #2]
New messages in the room (oldest first):
User: Do you guys have access to my chats that i've sent to you? or are you guys just running off memories?

It's your turn, Bot. Reply in character with SendToUser if you have something worth adding; if you don't, end your turn without sending anything.`);
  });

  test("formats group reply, participant, attachment, and wind-down variants", () => {
    expect(
      buildGroupTurnPrompt({
        groupName: "Testing",
        targetId: "test-2",
        targetName: "Test #2",
        members: [
          {
            id: "bot",
            name: "Bot",
            description: "The user works with Workspace every day.",
          },
          { id: "test-2", name: "Test #2" },
        ],
        messages: [
          {
            sender: "agent",
            senderName: "Bot",
            content: "Same here.",
            reply: { sender: "user", content: "Can you both confirm?" },
          },
        ],
        wrappingUp: true,
      })
    ).toContain(
      'Participants: Bot (The user works with Workspace every day.)\nNew messages in the room (oldest first):\nBot: [in reply to User: "Can you both confirm?"] Same here.'
    );
    expect(
      buildGroupTurnPrompt({
        groupName: "Files",
        roomDescription: "  Production launch triage  ",
        targetId: "one",
        targetName: "One",
        members: [{ id: "one", name: "One" }],
        messages: [{ sender: "user", content: "", hasImages: true }],
      })
    ).toContain(
      '[Group chat: "Files"]\nRoom: Production launch triage\nThe user shared attachments with the room.'
    );
  });

  test("uses OpenTeam's viewer/user labels and 8,000-character reply quote cap", () => {
    const prompt = buildGroupTurnPrompt({
      groupName: "Testing",
      targetId: "self",
      targetName: "Self",
      members: [
        { id: "self", name: "Self" },
        { id: "peer", name: "Peer" },
      ],
      messages: [
        { sender: "user", senderName: "Raghav", content: "Question" },
        { sender: "agent", senderId: "self", senderName: "Self", content: "Earlier" },
        {
          sender: "agent",
          senderId: "peer",
          senderName: "Peer",
          content: "Reply",
          reply: {
            sender: "user",
            senderName: "Raghav",
            content: `  ${"x".repeat(8_100)}  `,
          },
        },
      ],
    });
    expect(prompt).toContain("Raghav (user): Question");
    expect(prompt).toContain("Self (you): Earlier");
    expect(prompt).toContain(
      `Peer: [in reply to Raghav (user): ${JSON.stringify("x".repeat(8_000))}] Reply`
    );
    expect(prompt).not.toContain("x".repeat(8_001));
  });

  test("prepends the exact OpenTeam automation status reminder", () => {
    const wake = directAgentWake({
      senderId: "57d95f5a-e68f-48a0-bba0-409b086f5da8",
      senderName: "a2a",
      message: "BOT_A2A_REF — reply with exactly ACK BOT_A2A_REF",
      priority: false,
      interrupted: false,
      routineStatuses: [
        {
          name: "parity-probe-handwritten",
          folder: "parity-probe-handwritten",
          status: "never run",
        },
        {
          name: "parity-probe-harmless",
          folder: "parity-probe-harmless",
          status: "never run",
        },
      ],
    });
    expect(wake).toStartWith(`[SAND_HIDDEN_PROMPT]<system_reminder>
<automation_status>
Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.
- parity-probe-handwritten (folder parity-probe-handwritten): never run
- parity-probe-harmless (folder parity-probe-harmless): never run
</automation_status>
</system_reminder>

[agent] A message just arrived from another of your user's agents: a2a`);
    expect(wake).not.toEndWith("[SAND_HIDDEN_PROMPT]");
    expect(wake).not.toContain("<peer_message_json>");
  });

  test("matches the observed priority wake paragraph", () => {
    const wake = directAgentWake({
      senderId: "agent-2",
      senderName: "Planner",
      message: "Please re-check the plan.",
      priority: true,
      interrupted: true,
    });
    expect(wake).toContain(
      "This is a PRIORITY instruction from another assistant — not the user typing here. It interrupted your previous non-user work. Drop conflicting in-flight work and follow it now. Your user can already see it in this chat."
    );
    expect(
      directAgentWake({
        senderId: "agent-2",
        senderName: "Planner",
        message: "Please re-check the plan.",
        priority: true,
        interrupted: false,
      })
    ).toContain(
      "This is a PRIORITY instruction from another assistant — not the user typing here. Handle it ahead of other non-user work. Your user can already see it in this chat."
    );
  });

  test("uses OpenTeam's exact room-turn message-limit notice", () => {
    expect(GROUP_MEMBER_TURN_MESSAGE_LIMIT_NOTICE).toBe(
      "Not delivered — you've reached this room turn's 3-message limit. Consolidate, or wait for your next turn."
    );
  });

  test("renders routine runtime states deterministically", () => {
    expect(routineRuntimeStatus({ runLedger: [], lastRunAt: null }, "UTC")).toBe("never run");
    expect(
      routineRuntimeStatus(
        {
          runLedger: [{ status: "running", startedAt: Date.parse("2026-08-27T19:00:00.000Z") }],
          lastRunAt: "2026-08-27T19:00:00.000Z",
        },
        "UTC"
      )
    ).toBe("last run 8/27/2026, 7:00:00 PM (running)");
    expect(
      routineRuntimeStatus(
        {
          runLedger: [
            {
              status: "ok",
              startedAt: Date.parse("2026-08-27T19:00:00.000Z"),
              finishedAt: Date.parse("2026-08-27T19:00:05.000Z"),
            },
          ],
          lastRunAt: "2026-08-27T19:00:00.000Z",
        },
        "UTC"
      )
    ).toBe("last run 8/27/2026, 7:00:05 PM (succeeded)");
    expect(
      routineRuntimeStatus(
        {
          runLedger: [{ status: "error", startedAt: Date.parse("2026-08-27T19:00:00.000Z") }],
          lastRunAt: "2026-08-27T19:00:00.000Z",
        },
        "UTC"
      )
    ).toBe("last run 8/27/2026, 7:00:00 PM (failed)");
  });

  test("platform instructions forbid polling, reply misuse, and unsolicited fan-out", () => {
    expect(A2A_PLATFORM_INSTRUCTIONS).toContain("Never wait or poll");
    expect(A2A_PLATFORM_INSTRUCTIONS).toContain("Reply to a peer with SendToAgent");
    expect(A2A_PLATFORM_INSTRUCTIONS).toContain("A direct question, request");
    expect(A2A_PLATFORM_INSTRUCTIONS).toContain("never create acknowledgement ping-pong");
    expect(A2A_PLATFORM_INSTRUCTIONS).toContain("explicitly asked for that collaboration");
  });
});
