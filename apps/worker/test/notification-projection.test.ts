import { describe, expect, test } from "bun:test";
import { Projection } from "../src/projection";

type Delivery = {
  deliveryKey: string;
  payload: Record<string, unknown>;
};

const notificationProjection = ({
  initialStatus = "running",
  lastMessage = { content: "Finished output", metadata: null },
  originChannelKind = "bot_dm",
}: {
  initialStatus?: string;
  lastMessage?: { content: string; metadata: unknown } | null;
  originChannelKind?: "bot_dm" | "group";
} = {}) => {
  let status = initialStatus;
  const deliveries: Delivery[] = [];
  const bot = {
    id: "bot-1",
    name: "Probe",
    notificationsEnabled: true,
    hiddenFromSidebar: false,
  };
  const channel = { id: "channel-1", kind: "bot_dm", archivedAt: null };
  const originChannel = {
    id: originChannelKind === "group" ? "group-1" : channel.id,
    kind: originChannelKind,
    archivedAt: null,
  };
  const tx = {
    run: {
      findUniqueOrThrow: async () => ({ status }),
      findUnique: async () => ({ bot, channel: originChannel }),
      update: async ({ data }: { data: { status?: string } }) => {
        if (data.status) status = data.status;
        return { status };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { status: { in: string[] } };
        data: { status: string };
      }) => {
        if (!where.status.in.includes(status)) return { count: 0 };
        status = data.status;
        return { count: 1 };
      },
    },
    runItem: {
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    approval: {
      upsert: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    message: { updateMany: async () => ({ count: 0 }) },
    event: { create: async () => ({}) },
    channelMessage: {
      findFirst: async () => lastMessage,
      findMany: async () => [],
    },
    channel: {
      findFirst: async () => channel,
      findMany: async () => [],
    },
    pushDevice: { findMany: async () => [{ id: "device-1" }] },
    outboxDelivery: {
      createMany: async ({ data }: { data: Delivery[] }) => {
        deliveries.push(...data);
        return { count: data.length };
      },
    },
  };
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  };
  return {
    projection: new Projection(prisma as never),
    deliveries,
    status: () => status,
  };
};

describe("Grok-compatible notification transitions", () => {
  test("notifies only on the first transition into waiting for input", async () => {
    const harness = notificationProjection();
    const projection = harness.projection;

    await projection.apply("run-1", "conversation-1", "bot-1", {
      type: "approval.requested",
      approvalId: "approval-1",
      turnId: "turn-1",
      itemId: "item-1",
      requestMethod: "item/commandExecution/requestApproval",
      details: { reason: "Approve this command" },
    });
    await projection.apply("run-1", "conversation-1", "bot-1", {
      type: "approval.requested",
      approvalId: "approval-2",
      turnId: "turn-1",
      itemId: "item-2",
      requestMethod: "item/fileChange/requestApproval",
      details: { reason: "Approve this edit" },
    });

    expect(harness.status()).toBe("waiting_approval");
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]?.payload).toMatchObject({
      kind: "agent-needs-input",
      approvalId: "approval-1",
    });
  });

  test("a cancelled run still notifies when it produced a new bot message", async () => {
    const harness = notificationProjection({ initialStatus: "cancelled" });

    await harness.projection.apply("run-1", "conversation-1", "bot-1", {
      type: "turn.completed",
      turnId: "turn-1",
      status: "interrupted",
    });

    expect(harness.status()).toBe("cancelled");
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]?.payload).toMatchObject({
      kind: "agent-done",
      runId: "run-1",
    });
  });

  test("an interactive bot message uses needs-input instead of done", async () => {
    const harness = notificationProjection({
      lastMessage: {
        content: "Deploy to production?",
        metadata: { type: "widget", interactive: true },
      },
    });

    await harness.projection.apply("run-1", "conversation-1", "bot-1", {
      type: "turn.completed",
      turnId: "turn-1",
      status: "completed",
    });

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]?.payload).toMatchObject({
      kind: "agent-needs-input",
      title: "Probe needs you",
      body: "Deploy to production?",
    });
  });

  test("a group-origin run notifies only through the bot's private home message", async () => {
    const harness = notificationProjection({ originChannelKind: "group" });

    await harness.projection.apply("run-1", "conversation-1", "bot-1", {
      type: "turn.completed",
      turnId: "turn-1",
      status: "completed",
    });

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]?.payload).toMatchObject({
      kind: "agent-done",
      channelId: "channel-1",
    });
  });

  test("a terminal run without a bot message does not notify", async () => {
    const harness = notificationProjection({ initialStatus: "cancelled", lastMessage: null });

    await harness.projection.apply("run-1", "conversation-1", "bot-1", {
      type: "turn.completed",
      turnId: "turn-1",
      status: "interrupted",
    });

    expect(harness.deliveries).toHaveLength(0);
  });
});
