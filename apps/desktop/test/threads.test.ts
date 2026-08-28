import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openbot/contracts";
import { deriveThreads, isBranchedMessage } from "../src/renderer/lib/threads";

const message = (
  id: string,
  sequence: number,
  replyTo?: string,
  branched = false
): ChannelMessageView =>
  ({
    id,
    channelId: "channel",
    sequence,
    sender: sequence % 2 ? "user" : "agent",
    senderBotId: sequence % 2 ? null : "bot",
    sourceRunId: null,
    content: id,
    metadata: replyTo ? { replyTo, ...(branched ? { branched } : {}) } : {},
    createdAt: new Date(sequence * 1_000).toISOString(),
  }) as ChannelMessageView;

describe("Grok-compatible branched threads", () => {
  test("keeps ordinary replies in the main transcript and branches out forked replies", () => {
    const root = message("root", 1);
    const ordinary = message("ordinary", 2, "root");
    const first = message("first", 3, "root", true);
    const second = message("second", 4, "first", true);
    const threads = deriveThreads([root, ordinary, first, second]);
    expect(isBranchedMessage(ordinary)).toBe(false);
    expect([...threads.keys()]).toEqual(["root"]);
    expect(threads.get("root")?.replies.map(({ id }) => id)).toEqual(["first", "second"]);
  });
});
