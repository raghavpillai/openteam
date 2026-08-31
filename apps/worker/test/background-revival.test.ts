import { expect, test } from "bun:test";
import { WakeWorker } from "../src/worker";

test("background subagent completion revives the parent with Grok's dedicated source", async () => {
  const calls: unknown[] = [];
  const worker = Object.create(WakeWorker.prototype) as {
    notifySubagentParent: (...args: unknown[]) => Promise<void>;
  };
  Object.assign(worker, {
    prisma: {
      bot: {
        findUnique: async () => ({ id: "parent", status: "active" }),
      },
    },
    messaging: {
      enqueueWake: async (_tx: unknown, input: unknown) => {
        calls.push(input);
        return {};
      },
    },
  });

  await worker.notifySubagentParent(
    {
      bot: {
        findUnique: async () => ({ id: "parent", status: "active" }),
      },
    } as never,
    {
      id: "subagent-1",
      parentBotId: "parent",
      parentChannelId: "channel-1",
      description: "Check release",
      subagentType: "executor",
      currentRunId: "child-run-1",
      outputPath: "/tmp/result.jsonl",
    },
    "completed",
    "Release checks passed."
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    botId: "parent",
    channelId: "channel-1",
    origin: "background_revival",
    type: "subagent.completed",
    priority: 260,
    wrapUserContent: false,
  });
});
