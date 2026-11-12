import { describe, expect, test } from "bun:test";
import {
  groupVisibilityClauses,
  parseGroupMentions,
  resolveGroupResponderIds,
} from "../src/group-routing";

const members = [
  { id: "one", name: "Parity Probe v3" },
  { id: "two", name: "Research Bot" },
  { id: "three", name: "QA" },
];

describe("OpenTeam-compatible group routing", () => {
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

  test("freezes the base snapshot while admitting only earlier same-round outputs", () => {
    expect(
      groupVisibilityClauses({
        rootSequence: 97n,
        triggerSequence: 100n,
        lastTargetSequence: null,
        earlierRunIds: ["run-first", "run-first", "run-second"],
      })
    ).toEqual([
      { sequence: { lte: 100n } },
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

test("mention boundaries match punctuation, Unicode names and full spaced names", () => {
  const people = [{ id: "qa", name: "QA" }, { id: "jp", name: "日本語" }, { id: "spaced", name: "Research Bot" }];
  for (const input of ["@QA.foo", "@QA_hello", "@QA-hello", "(@QA), hi"]) expect(parseGroupMentions(input, people).memberIds).toEqual(["qa"]);
  expect(parseGroupMentions("@Research Bot", people).memberIds).toEqual(["spaced"]);
  expect(parseGroupMentions("@日本語", people).memberIds).toEqual(["jp"]);
  expect(parseGroupMentions("email@QA.com x@QA @QAbot", people).memberIds).toEqual([]);
});
