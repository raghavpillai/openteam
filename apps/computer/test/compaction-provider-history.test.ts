import { expect, test } from "bun:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { reduceBotSummaryInputMessages } from "../src/bot-compaction";

test("reference retry reduction keeps valid Pi tool histories serializable", async () => {
  const model: any = {
    id: "retry-history",
    name: "Retry history",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://offline.invalid/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const assistant = (content: any[]) => ({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
    stopReason: content.some((p) => p.type === "toolCall") ? "toolUse" : "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  let serialized = 0;
  let syntheticResults = 0;
  for (const width of [1, 2, 3])
    for (const prefix of [0, 2, 4, 8]) {
      for (const suffix of [0, 3, 7])
        for (const unfinished of [false, true]) {
          const original: any[] = [
            { role: "user", content: "Keep blue", timestamp: 1 },
            ...Array.from({ length: prefix }, (_, i) =>
              assistant([{ type: "text", text: `before-${i}` }])
            ),
            assistant(
              Array.from({ length: width }, (_, i) => ({
                type: "toolCall",
                id: `read-${i}`,
                name: "ReadFixture",
                arguments: { index: i },
              }))
            ),
            ...Array.from({ length: width - (unfinished ? 1 : 0) }, (_, i) => ({
              role: "toolResult",
              toolCallId: `read-${i}`,
              toolName: "ReadFixture",
              content: [{ type: "text", text: `result-${i}` }],
              isError: false,
              timestamp: 1,
            })),
            // An unfinished exchange ends the captured history; no later messages
            // are fabricated before its missing result.
            ...(!unfinished
              ? Array.from({ length: suffix }, (_, i) =>
                  assistant([{ type: "text", text: `after-${i}` }])
                )
              : []),
          ];
          const snapshot = structuredClone(original);
          let reduced = original;
          for (let reduction = 0; reduction < 3; reduction++) {
            reduced = reduceBotSummaryInputMessages(reduced);
            let body: any;
            const result = await streamSimple(
              model,
              {
                systemPrompt: "Fixture",
                messages: [
                  ...reduced,
                  { role: "user", content: "Summarize", timestamp: 1 },
                ] as never,
                tools: [
                  {
                    name: "ReadFixture",
                    description: "Read fixture",
                    parameters: { type: "object", properties: { index: { type: "number" } } },
                  },
                ] as never,
              },
              {
                apiKey: "synthetic-fixture",
                maxRetries: 0,
                fetch: (async (_url: unknown, init: any) => {
                  body = JSON.parse(await new Response(init.body).text());
                  return new Response(
                    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
                    { headers: { "content-type": "text/event-stream" } }
                  );
                }) as typeof fetch,
              }
            ).result();
            expect(result.stopReason).toBe("stop");
            expect(body).toBeDefined();
            let pending = new Set<string>();
            for (const message of body.messages) {
              if (message.role === "tool") {
                expect(pending.delete(message.tool_call_id)).toBe(true);
                if (message.content === "No result provided") syntheticResults++;
              } else {
                expect(pending.size).toBe(0);
                pending = new Set((message.tool_calls ?? []).map((call: any) => call.id));
              }
            }
            expect(pending.size).toBe(0);
            expect(original).toEqual(snapshot);
            serialized++;
          }
        }
    }
  expect(serialized).toBe(216);
  expect(syntheticResults).toBeGreaterThan(0);
});
