import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RichMessageService } from "../src/services/rich-message-service";

const message = {
  id: "message-1",
  clientId: "tool:request-1",
  sequence: 7n,
  channelId: "channel-1",
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: "run-1",
  content: "Finish 2FA",
  metadata: {
    type: "computer-handoff",
    computerHandoff: { reason: "Finish 2FA" },
  } as Record<string, unknown>,
  createdAt: new Date("2026-09-02T12:00:00.000Z"),
  channel: { archivedAt: null },
};

const fixture = () => {
  const takeovers: boolean[] = [];
  const wakes: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 1,
    channelMessage: {
      findUnique: async () => message,
      update: async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        message.metadata = data.metadata;
        return message;
      },
    },
    event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
  };
  const service = new RichMessageService(
    { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) } as never,
    {
      enqueueWake: async (_tx: unknown, input: Record<string, unknown>) => {
        wakes.push(input);
        return { run: { id: "resume-run-1" } };
      },
      scheduleTranscriptProjection: async () => undefined,
    } as never,
    {} as never,
    {
      takeover: (_botId: string, active: boolean) => {
        takeovers.push(active);
        return Effect.succeed({ humanTakeover: active });
      },
    } as never
  );
  return { events, service, takeovers, wakes };
};

describe("computer handoff lifecycle", () => {
  test("leases on start, releases on completion, and enqueues one resume", async () => {
    const { events, service, takeovers, wakes } = fixture();
    const started = await Effect.runPromise(
      service.mutateComputerHandoff("message-1", {
        action: "start",
        clientId: "desktop-client-1",
      })
    );
    expect(started).toMatchObject({ accepted: true, runId: null });
    expect(message.metadata).toMatchObject({ computerHandoffState: "active" });

    const completed = await Effect.runPromise(
      service.mutateComputerHandoff("message-1", {
        action: "complete",
        clientId: "desktop-client-2",
      })
    );
    expect(completed).toMatchObject({ accepted: true, runId: "resume-run-1" });
    expect(message.metadata).toMatchObject({ computerHandoffState: "completed" });
    expect(takeovers).toEqual([true, false]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      botId: "bot-1",
      channelId: "channel-1",
      origin: "handoff_resume",
      type: "computer-handoff.completed",
    });
    expect(events.map((event) => event.topic)).toEqual([
      "channel.message.updated",
      "channel.message.updated",
    ]);

    const duplicate = await Effect.runPromise(
      service.mutateComputerHandoff("message-1", {
        action: "dismiss",
        clientId: "desktop-client-3",
      })
    );
    expect(duplicate).toMatchObject({ accepted: false, runId: null });
    expect(takeovers).toEqual([true, false]);
    expect(wakes).toHaveLength(1);
  });
});
