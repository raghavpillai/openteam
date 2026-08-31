import { describe, expect, test } from "bun:test";
import {
  closeA2AExchange,
  deriveA2AExchange,
  finishA2AExchangeAnimation,
  startA2AExchange,
} from "../src/renderer/lib/a2a-exchange";

describe("A2A exchange sheet lifecycle", () => {
  test("opens without changing the source-channel identity", () => {
    expect(startA2AExchange("source-home", "source-agent", "peer-agent")).toEqual({
      sourceChannelId: "source-home",
      sourceBotId: "source-agent",
      peerId: "peer-agent",
      phase: "entering",
    });
  });

  test("settles after entering, then remains stable", () => {
    const entering = startA2AExchange("source-home", "source-agent", "peer-agent");
    const open = finishA2AExchangeAnimation(entering);
    expect(open).toEqual({ ...entering, phase: "open" });
    expect(open && finishA2AExchangeAnimation(open)).toBe(open);
  });

  test("reverses out before unmounting", () => {
    const open = {
      ...startA2AExchange("source-home", "source-agent", "peer-agent"),
      phase: "open" as const,
    };
    const exiting = closeA2AExchange(open);
    expect(exiting.phase).toBe("exiting");
    expect(closeA2AExchange(exiting)).toBe(exiting);
    expect(finishA2AExchangeAnimation(exiting)).toBeNull();
  });

  test("derives the view-only pair transcript from one agent's mirrored home rows", () => {
    const source = {
      id: "source-agent",
      name: "Source",
      dmChannelId: "source-home",
    } as Parameters<typeof deriveA2AExchange>[0]["source"];
    const peer = {
      id: "peer-agent",
      name: "Peer",
      dmChannelId: "peer-home",
    } as Parameters<typeof deriveA2AExchange>[0]["peer"];
    const sourceChannel = {
      id: "source-home",
      kind: "bot_dm",
      name: "Source",
      description: "",
      hasAvatar: false,
      directKey: null,
      workingDirectory: null,
      members: [{ botId: source.id, ordinal: 0 }],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
    } as const;
    const base = {
      channelId: sourceChannel.id,
      sourceRunId: null,
      sequence: "1",
      createdAt: "2026-08-28T00:00:02.000Z",
    };
    const exchange = deriveA2AExchange({
      source,
      peer,
      sourceChannel,
      sourceMessages: [
        {
          ...base,
          id: "out",
          sender: "agent",
          senderBotId: source.id,
          content: "Ping",
          metadata: { toAgent: { id: peer.id, name: peer.name, kind: "agent" } },
        },
        {
          ...base,
          id: "in",
          sequence: "2",
          sender: "user",
          senderBotId: source.id,
          content: "ACK",
          metadata: { fromAgent: { id: peer.id, name: peer.name } },
        },
        {
          ...base,
          id: "ordinary",
          sequence: "3",
          sender: "user",
          senderBotId: null,
          content: "Not part of the exchange",
          metadata: {},
        },
      ],
    });
    expect(exchange.channel).toMatchObject({
      kind: "agent_dm",
      name: "Source ↔ Peer",
      members: [
        { botId: source.id, ordinal: 0 },
        { botId: peer.id, ordinal: 1 },
      ],
    });
    expect(
      exchange.messages.map(({ content, sender, senderBotId }) => ({
        content,
        sender,
        senderBotId,
      }))
    ).toEqual([
      { content: "Ping", sender: "agent", senderBotId: source.id },
      { content: "ACK", sender: "agent", senderBotId: peer.id },
    ]);
  });
});
