import { expect, test } from "bun:test";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { botUserInfoMessage } from "../src/bot-compaction";
import { pinUserInfo } from "../src/runtime/user-info-snapshot";

// Cache-control markers move to the newest boundary; Anthropic also expands a
// string into a single text block to attach one. Normalize only these equivalent
// representations, preserving every model-visible text byte and its order.
const semantic = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (key === "cache_control") return undefined;
      if (key === "content" && typeof item === "string") return [{ type: "text", text: item }];
      return item;
    })
  );

for (const route of [
  { api: "openai-completions", provider: "openrouter", stream: completions },
  { api: "openai-responses", provider: "openai", stream: responses },
  { api: "anthropic-messages", provider: "anthropic", stream: anthropic },
])
  test(`long conversation prefix survives ${route.api} serialization`, async () => {
    const model: any = {
      id: "cache-fixture",
      name: "Cache fixture",
      provider: route.provider,
      api: route.api,
      baseUrl: "https://offline.invalid/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const receipt = {
      role: "assistant",
      content: [{ type: "text", text: "Earlier work complete." }],
      provider: model.provider,
      api: model.api,
      model: model.id,
      timestamp: 1,
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const send = async (messages: any[]) => {
      const requests: any[] = [];
      const result = await (route.stream as typeof completions)(
        model,
        {
          systemPrompt: "Keep the original scope.",
          messages,
          tools: [
            {
              name: "ReadFixture",
              description: "Read only",
              parameters: { type: "object", properties: {} },
            },
          ] as any,
        },
        {
          apiKey: "synthetic",
          maxRetries: 0,
          transport: "sse",
          fetch: (async (_url: unknown, init: RequestInit) => {
            requests.push(JSON.parse(await new Response(init.body).text()));
            // Deliberately stop after serialization. No external call is made.
            return Response.json(
              { error: { type: "invalid_request_error", message: "Captured offline" } },
              { status: 400 }
            );
          }) as typeof fetch,
        }
      ).result();
      expect(result.stopReason).toBe("error");
      expect(requests).toHaveLength(1);
      return requests[0];
    };
    const entries: any[] = [];
    const log = {
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data: unknown) =>
        entries.push({ type: "custom", customType, data }),
    };
    const original =
      "<user_info>Today's date: Friday Nov 13, 2026</user_info>\n\n<teammates>Original teammate</teammates>";
    const changed =
      "<user_info>Today's date: Saturday Nov 14, 2026</user_info>\n\n<teammates>Original teammate; New Teammate</teammates>";
    const snapshot = pinUserInfo(log, 0, original, null);
    const history: any[] = [
      botUserInfoMessage(snapshot.content, 0),
      { role: "user", content: "Long saved history. ".repeat(50000), timestamp: 1 },
      receipt,
      { role: "user", content: "Continue the task.", timestamp: 2 },
    ];
    const before = await send(history);
    const next = pinUserInfo(log, 0, changed, null);
    const suffix: any[] = [
      receipt,
      { role: "user", content: next.update, timestamp: 3 },
      { role: "user", content: "Next turn", timestamp: 4 },
    ];
    const after = await send([botUserInfoMessage(next.content, 0), ...history.slice(1), ...suffix]);
    const earlierMessages = semantic(before.messages ?? before.input);
    const laterMessages = semantic(after.messages ?? after.input);
    expect(Array.isArray(earlierMessages)).toBe(true);
    expect(laterMessages.slice(0, earlierMessages.length)).toEqual(earlierMessages);
    expect(after.system).toEqual(before.system);
    expect(after.instructions).toEqual(before.instructions);
    expect(after.tools).toEqual(before.tools);
    expect(JSON.stringify(laterMessages.slice(earlierMessages.length))).toContain("New Teammate");
    // Negative control: the old implementation really does alter this provider's
    // serialized prefix when its leading user_info is rebuilt from live inputs.
    const broken = await send([botUserInfoMessage(changed, 0), ...history.slice(1), ...suffix]);
    expect(semantic(broken.messages ?? broken.input).slice(0, earlierMessages.length)).not.toEqual(
      earlierMessages
    );
  });
