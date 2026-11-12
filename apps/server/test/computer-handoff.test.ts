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
  const tx = {
    $executeRaw: async () => 1,
    channelMessage: {
      findUnique: async () => message,
      update: async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        message.metadata = data.metadata;
        return message;
      },
    },
    event: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  };
  const service = new RichMessageService(
    {
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    } as never,
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
  return { service, takeovers, wakes };
};

describe("computer handoff lifecycle", () => {
  for (const action of ["skip", "complete", "dismiss"] as const) {
    test(`returns control and resumes once after an escalated form is ${action}`, async () => {
      message.metadata = { type: "user-form", cardState: "escalated", form: { id: "form-1", title: "Google sign-in" } };
      const { service, takeovers, wakes } = fixture();
      const result = await Effect.runPromise(service.mutateComputerHandoff(message.id, { action, clientId: "desktop-client-1" }));
      expect(result.accepted).toBe(true);
      expect(takeovers).toEqual([false]);
      expect(wakes).toHaveLength(1);
      const duplicate = await Effect.runPromise(service.mutateComputerHandoff(message.id, { action, clientId: "desktop-client-1" }));
      expect(duplicate.accepted).toBe(false);
      expect(wakes).toHaveLength(1);
    });
  }
  test("leases on start, releases on completion, and enqueues one resume", async () => {
    message.metadata = { type: "computer-handoff", computerHandoff: { reason: "Finish 2FA" } };
    const { service, takeovers, wakes } = fixture();
    const mutate = (action: "start" | "complete" | "dismiss", clientId: string) =>
      Effect.runPromise(service.mutateComputerHandoff("message-1", { action, clientId }));
    expect(await mutate("start", "desktop-client-1")).toMatchObject({ accepted: true, runId: null });
    expect(message.metadata).toMatchObject({ computerHandoffState: "active" });
    expect(await mutate("complete", "desktop-client-2")).toMatchObject({ accepted: true, runId: "resume-run-1" });
    expect(message.metadata).toMatchObject({ computerHandoffState: "completed" });
    expect(wakes).toEqual([expect.objectContaining({ botId: "bot-1", channelId: "channel-1", origin: "handoff_resume", type: "computer-handoff.completed" })]);
    expect(await mutate("dismiss", "desktop-client-3")).toMatchObject({ accepted: false, runId: null });
    expect(takeovers).toEqual([true, false]);
    expect(wakes).toHaveLength(1);
  });
});
