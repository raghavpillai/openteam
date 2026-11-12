import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BotCompactionArchiveStore,
  BotCompactionCoordinator,
  estimateBotContextTokens,
  estimateBotMeasuredContextTokens,
  type BotMessage,
} from "../src/bot-compaction";
import { compactionObservation } from "../src/runtime/compaction";
import type { ActiveTurn } from "../src/runtime/types";

const dense = Array.from(
  { length: 270 },
  (_, i) => createHash("sha256").update(`fixture:${i}`).digest("hex").repeat(3) + "\n"
).join("");
const measured = (stopReason = "toolUse", input = 244_000): BotMessage => ({
  role: "assistant",
  content: [],
  stopReason,
  usage: { input, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: input + 100 },
});
const result: BotMessage = {
  role: "toolResult",
  toolCallId: "read-fixture",
  content: [{ type: "text", text: dense }],
};

test("dense results cross capacity before another request instead of trusting chars/4", () => {
  expect(244_100 + Math.ceil(dense.length / 4)).toBeLessThan(272_000);
  expect(estimateBotMeasuredContextTokens([measured(), result])).toBeGreaterThan(272_000);
  const active = {
    contextSessionId: "qa",
    instructions: "system",
    modelRef: {},
    session: {
      messages: [measured(), result],
      getContextUsage: () => ({ tokens: 255_680, contextWindow: 272_000 }),
      getAllTools: () => [],
    },
  } as unknown as ActiveTurn;
  expect(compactionObservation(active).usedTokens).toBe(
    estimateBotMeasuredContextTokens([measured(), result])
  );
});

test("provider usage replaces estimates without recounting the measured prefix", () => {
  const messages = [result, measured(), result];
  const first = estimateBotMeasuredContextTokens(messages)!;
  expect(first).toBeGreaterThan(244_100);
  expect(estimateBotMeasuredContextTokens([...messages, measured("stop", 250_000)])).toBe(250_100);
  expect(estimateBotMeasuredContextTokens([result])).toBeNull();
  for (const reason of ["error", "aborted", "pending"])
    expect(estimateBotMeasuredContextTokens([...messages, measured(reason, 900_000)])).toBeLessThan(
      300_000
    );
});

test("Unicode and literal special-token strings are counted; image bytes are excluded", () => {
  expect(
    estimateBotContextTokens("", [{ role: "toolResult", content: "雪🙂λ".repeat(1000) }])
  ).toBeGreaterThan(2000);
  expect(
    estimateBotContextTokens("<|endoftext|>", [{ role: "user", content: "<|fim_suffix|>" }])
  ).toBeGreaterThan(0);
  const withImage = (data: string) =>
    estimateBotContextTokens("", [{ role: "toolResult", content: [{ type: "image", data }] }]);
  expect(withImage("small")).toBe(withImage("x".repeat(1_000_000)));
});

test("dense appended results wait for compaction before the next model step", async () => {
  const root = await mkdtemp(join(tmpdir(), "dense-capacity-"));
  try {
    const store = new BotCompactionArchiveStore(root);
    const coordinator = new BotCompactionCoordinator(store, 0);
    let finish!: (value: { text: string }) => void;
    const summary = new Promise<{ text: string }>((resolve) => {
      finish = resolve;
    });
    const observation = {
      contextSessionId: "04d8c9a2-a550-4813-b2e0-8116635a1a31",
      piMessages: [
        { role: "user", content: "Keep marker cedar-雪 and continue the fixture reads." },
        measured(),
        result,
      ],
      systemPrompt: "QA",
      usedTokens: estimateBotMeasuredContextTokens([measured(), result]),
      maxTokens: 272_000,
      infer: () => summary,
    };
    await coordinator.observe(observation);
    let ready = false;
    const waiting = coordinator
      .waitForModelCapacity(observation, new AbortController().signal)
      .then(() => {
        ready = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ready).toBe(false);
    finish({
      text: "Keep marker cedar-雪. The fixture read succeeded; continue the remaining reads.",
    });
    await waiting;
    const projected = await coordinator.modelContextMessages(observation);
    expect(JSON.stringify(projected)).toContain("cedar-雪");
    expect((await store.manifest("04d8c9a2-a550-4813-b2e0-8116635a1a31")).epoch).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
