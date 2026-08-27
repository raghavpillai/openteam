import { expect, test } from "bun:test";
import { Projection } from "../src/projection";

test("completed turns preserve durable plugin approvals while expiring runtime approvals", async () => {
  const approvals = [
    { requestMethod: "plugin/tool", status: "pending" },
    { requestMethod: "item/commandExecution/requestApproval", status: "pending" },
  ];
  const tx = {
    run: {
      findUniqueOrThrow: async () => ({ status: "running" }),
      update: async () => ({}),
    },
    runItem: { updateMany: async () => ({ count: 0 }) },
    message: { updateMany: async () => ({ count: 0 }) },
    approval: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { status: string; requestMethod: { not: string } };
        data: { status: string };
      }) => {
        let count = 0;
        for (const approval of approvals) {
          if (
            approval.status === where.status &&
            approval.requestMethod !== where.requestMethod.not
          ) {
            approval.status = data.status;
            count += 1;
          }
        }
        return { count };
      },
    },
    event: { create: async () => ({}) },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<void>) => work(tx),
  };

  await new Projection(prisma as never).apply("run-1", "conversation-1", "bot-1", {
    type: "turn.completed",
    turnId: "turn-1",
    status: "completed",
  });

  expect(approvals).toEqual([
    { requestMethod: "plugin/tool", status: "pending" },
    { requestMethod: "item/commandExecution/requestApproval", status: "expired" },
  ]);
});
