import { describe, expect, test } from "bun:test";
import {
  groupMemberMentionHandles,
  groupVisibilityClauses,
  parseGroupMentions,
  resolveGroupResponderIds,
  rotateGroupResponders,
} from "../src/group-routing";

const members = [
  { id: "one", name: "Parity Probe v3" },
  { id: "two", name: "Research Bot" },
  { id: "three", name: "QA" },
];

describe("Grok-compatible group routing", () => {
  test("builds full-name-without-spaces and first-token handles", () => {
    expect(groupMemberMentionHandles("Parity Probe v3")).toEqual(["parityprobev3", "parity"]);
  });

  test("matches bounded member handles and everyone aliases", () => {
    expect(parseGroupMentions("Ask @Parity and @researchbot.", members)).toEqual({
      isEveryone: false,
      memberIds: ["one", "two"],
    });
    expect(parseGroupMentions("hi@example.com and x@Parity should not match", members)).toEqual({
      isEveryone: false,
      memberIds: [],
    });
    expect(parseGroupMentions("@all take a look", members).isEveryone).toBe(true);
  });

  test("no mention and everyone route to all members", () => {
    expect(
      resolveGroupResponderIds(members, [{ sender: "user", content: "Please review" }])
    ).toEqual(["one", "two", "three"]);
    expect(
      resolveGroupResponderIds(members, [{ sender: "user", content: "@everyone review" }])
    ).toEqual(["one", "two", "three"]);
  });

  test("one or multiple mentions route only to matched members", () => {
    expect(resolveGroupResponderIds(members, [{ sender: "user", content: "@QA run it" }])).toEqual([
      "three",
    ]);
    expect(
      resolveGroupResponderIds(members, [
        { sender: "user", content: "@Parity start" },
        { sender: "agent", content: "@research please follow up" },
      ])
    ).toEqual(["one", "two"]);
  });

  test("routing scans only from the last user message", () => {
    expect(
      resolveGroupResponderIds(members, [
        { sender: "user", content: "@QA old task" },
        { sender: "agent", content: "done" },
        { sender: "user", content: "@Parity new task" },
      ])
    ).toEqual(["one"]);
  });

  test("attachment-only first round selects everyone and order rotates", () => {
    expect(resolveGroupResponderIds(members, [], { attachmentOnlyFirstRound: true })).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(rotateGroupResponders(["one", "two", "three"], 1)).toEqual(["two", "three", "one"]);
  });

  test("freezes the base snapshot while admitting only earlier same-round outputs", () => {
    expect(
      groupVisibilityClauses({
        rootSequence: 97n,
        triggerSequence: 100n,
        lastTargetSequence: null,
        earlierRunIds: ["run-first", "run-first", "run-second"],
      })
    ).toEqual([
      { sequence: { gte: 97n, lte: 100n } },
      {
        sender: "agent",
        sourceRunId: { in: ["run-first", "run-second"] },
        sequence: { gt: 100n },
      },
    ]);

    expect(
      groupVisibilityClauses({
        rootSequence: 97n,
        triggerSequence: 100n,
        lastTargetSequence: 99n,
        earlierRunIds: [],
      })
    ).toEqual([{ sequence: { gt: 99n, lte: 100n } }]);
  });
});
