import { expect, test } from "bun:test";
import type { ChannelHistoryPage, ChannelMessageView } from "@openteam/contracts";
import {
  emptyLoadedChannelHistory,
  mergeLoadedChannelHistoryPage,
  mergeLoadedChannelMessageContext,
  type LoadedChannelHistory,
} from "../src/history";
import { createChannelHistoryStore } from "../src/channel-history";
import { currentQuestion } from "../src/questions";

const question = (id = "q", metadata: Record<string, unknown> = {}): ChannelMessageView => ({
  id,
  channelId: "chat",
  sequence: /^q-\d+$/.test(id) ? String(Number(id.slice(2)) + 1) : "1",
  sender: "agent",
  senderBotId: "bot",
  sourceRunId: null,
  content: "Which color?",
  createdAt: "2026-11-14T00:00:00Z",
  metadata: {
    type: "widget",
    widget: { prompt: "Which color?", options: [{ label: "Blue" }] },
    ...metadata,
  },
});
const page = (
  messages: ChannelMessageView[],
  threadContext: ChannelMessageView[] = []
): ChannelHistoryPage => ({
  channelId: "chat",
  messages,
  threadContext,
  threadContextTruncated: false,
  beforeSequence: messages[0]?.sequence ?? null,
  hasMore: true,
  revision: "1",
});
const lanes = ["messages", "threadContext", "searchContext", "searchThreadContext"] as const;
const rows = (history: LoadedChannelHistory) => lanes.flatMap((lane) => history[lane]);
const settlements = [
  { respondedValue: "Blue", widgetResponseClientId: "answer" },
  { widgetDismissed: true, widgetDismissalReason: "dismissed", widgetDismissClientId: "skip" },
];

for (const settlement of settlements) {
  for (const lane of lanes) {
    test(`terminal receipt survives stale replace/search/refresh from ${lane}: ${Object.keys(settlement)[0]}`, () => {
      const base = {
        ...emptyLoadedChannelHistory(),
        loadedAt: 1,
        [lane]: [question("q", settlement)],
      };
      for (const mode of ["replace", "refresh", "older"] as const) {
        const next = mergeLoadedChannelHistoryPage(base, page([question()]), mode, 2);
        expect(next.messages[0]!.metadata).toMatchObject(settlement);
        expect(currentQuestion(next.messages)).toBeNull();
      }
      const searched = mergeLoadedChannelMessageContext(base, {
        messages: [question()],
        threadContext: [],
        threadContextTruncated: false,
      });
      for (const copy of rows(searched).filter((row) => row.id === "q"))
        expect(copy.metadata).toMatchObject(settlement);
    });
  }
}

test("the real history store cannot forget a receipt before a delayed page returns", () => {
  const store = createChannelHistoryStore();
  store.acceptPage(page([question("q", settlements[0])]), "replace");
  store.acceptPage(page([]), "replace");
  store.acceptPage(page([question()]), "older");
  expect(store.visible("chat")![0]!.metadata).toMatchObject(settlements[0]!);
});

test("seeded delayed, duplicate and cross-lane pages never reopen a known receipt", () => {
  for (let seed = 1; seed <= 100; seed++) {
    let state = seed;
    const random = (n: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % n;
    };
    const store = createChannelHistoryStore();
    store.acceptPage(page([]), "replace");
    const known = new Map<string, Record<string, unknown>>();
    const canonical = new Map<string, Record<string, unknown>>();
    for (let step = 0; step < 80; step++) {
      const id = `q-${random(12)}`,
        settlement = settlements[random(2)]!;
      const settled = random(3) === 0;
      if (settled && !canonical.has(id)) canonical.set(id, settlement);
      const message = question(id, settled ? canonical.get(id)! : {});
      const operation = random(5);
      if (operation < 3) {
        const primary = random(2) ? [message] : [],
          thread = random(2) ? [message] : [];
        if (settled && (primary.length || thread.length)) known.set(id, canonical.get(id)!);
        store.acceptPage(
          page(primary, thread),
          (["replace", "refresh", "older"] as const)[operation]!
        );
      } else {
        if (settled) known.set(id, canonical.get(id)!);
        store.acceptContext({
          ...page([]),
          beforeSequence: "1",
          targetMessageId: id,
          afterSequence: "1",
          hasMoreBefore: false,
          hasMoreAfter: false,
          messages: operation === 3 ? [message] : [],
          threadContext: operation === 4 ? [message] : [],
          threadContextTruncated: false,
        });
      }
      // Track only receipts actually delivered in this step; a lost page is not knowledge.
      for (const row of store.retained("chat") ?? []) {
        const observed = row.metadata as Record<string, unknown>;
        if (
          !known.has(row.id) &&
          (typeof observed.respondedValue === "string" || observed.widgetDismissed === true)
        )
          known.set(row.id, observed);
      }
      for (const row of store.retained("chat") ?? []) {
        const receipt = known.get(row.id);
        if (receipt)
          expect(row.metadata, `seed=${seed} step=${step} id=${row.id}`).toMatchObject(receipt);
      }
    }
  }
});

test("accepted server sequence wins over reversed timestamps and render order", () => {
  const q = { ...question(), createdAt: "2026-11-14T01:00:00Z" };
  const user = {
    ...question("user"),
    sequence: "2",
    sender: "user" as const,
    metadata: {},
    createdAt: "2026-11-14T00:00:00Z",
  };
  // A transaction can start earlier but acquire the channel lock and sequence later.
  expect(currentQuestion([user, q])).toBeNull();
});

test("receipt retention is bounded and resets with channel/account ownership", async () => {
  const { createQuestionReceiptStore } = await import("../src/questions");
  const receipts = createQuestionReceiptStore(3, 1800);
  for (let i = 0; i < 20; i++)
    receipts.remember([question(`q-${i}`, { respondedValue: "x".repeat(100) })]);
  expect(receipts.size).toBeLessThanOrEqual(3);
  expect(receipts.bytes).toBeLessThanOrEqual(1800);
  expect(receipts.restore(question("q-19")).metadata).toHaveProperty("respondedValue");
  expect(receipts.restore({ ...question("q-19"), channelId: "other" }).metadata).not.toHaveProperty(
    "respondedValue"
  );
  for (const reset of ["delete", "clear"] as const) {
    const store = createChannelHistoryStore();
    store.acceptPage(page([question("q", settlements[0])]), "replace");
    if (reset === "delete") store.delete("chat");
    else store.clear();
    store.acceptPage(page([question()]), "replace");
    expect(currentQuestion(store.visible("chat")!)).not.toBeNull();
  }
});
