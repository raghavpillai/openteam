import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { createChannelHistoryStore } from "../src/channel-history";

const message = (
  index: number,
  overrides: Partial<ChannelMessageView> = {}
): ChannelMessageView => ({
  id: `message-${index}`,
  channelId: "chat",
  sequence: String(index),
  sender: "user",
  senderBotId: null,
  sourceRunId: null,
  content: "hello",
  metadata: {},
  createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  ...overrides,
});

describe("performance optimizations preserve product semantics", () => {
  test("history read caches are invalidated by every state transition and released on eviction", () => {
    const store = createChannelHistoryStore();
    const page = {
      channelId: "chat",
      messages: [message(1), message(2)],
      threadContext: [],
      threadContextTruncated: false,
      beforeSequence: "1",
      hasMore: false,
      revision: "2",
    };
    store.acceptPage(page, "replace");
    const visible = store.visible("chat");
    const ids = store.visibleIds("chat");
    const retained = store.retained("chat");
    expect(store.visible("chat")).toBe(visible);
    expect(store.visibleIds("chat")).toBe(ids);
    expect(store.retained("chat")).toBe(retained);
    store.setViewport("chat", ["message-2"], true);
    expect(store.visible("chat")).toBe(visible);
    store.patch(message(2, { content: "patched" }));
    expect(store.visible("chat")).not.toBe(visible);
    expect(store.visible("chat")!.at(-1)!.content).toBe("patched");
    store.acceptPage(
      { ...page, messages: [...page.messages, message(3)], revision: "3" },
      "refresh"
    );
    expect(store.visibleIds("chat")!.has("message-3")).toBe(true);
    store.delete("chat");
    expect(store.visible("chat")).toBeNull();
    expect(store.visibleIds("chat")).toBeNull();
    expect(store.retained("chat")).toBeNull();
    store.acceptPage(page, "replace");
    expect(store.visible("chat")).not.toBe(visible);
    store.clear();
    expect(store.status("chat")).toBeNull();
  });
});
