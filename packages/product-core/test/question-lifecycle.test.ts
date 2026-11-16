import { expect, test } from "bun:test";
import type { ChannelHistoryPage, ChannelMessageView } from "@openteam/contracts";
import { channelMessageSummary } from "../src/channel-events";
import { createChannelHistoryStore } from "../src/channel-history";
import { emptyLoadedChannelHistory, mergeLoadedChannelHistoryPage, mergeLoadedChannelMessageContext, sortedUniqueMessages } from "../src/history";
import { createQuestionReceiptStore, currentQuestion, projectQuestionLifecycle } from "../src/questions";

const message = (
  id: string,
  sender = "agent",
  metadata: Record<string, unknown> = {}
): ChannelMessageView =>
  ({
    id,
    channelId: "chat",
    sender,
    senderBotId: sender === "agent" ? "bot" : null,
    content: id,
    createdAt: `2026-11-13T00:00:${id.padStart(2, "0")}Z`,
    sequence: id,
    metadata,
  }) as ChannelMessageView;
const question = (id: string, extra = {}) =>
  message(id, "agent", {
    type: "widget",
    widget: { prompt: "Which color?", options: [{ label: "Blue" }], allowCustom: true },
    ...extra,
  });

test("Enter moves past a card regardless of text; navigation, age and bot updates do not", () => {
  const q = question("1");
  expect(currentQuestion([q])?.id).toBe(q.id);
  expect(currentQuestion([q, message("2")])?.id).toBe(q.id);
  for (const content of ["Blue", "unrelated", ""]) {
    const user = { ...message("3", "user"), content };
    const projected = projectQuestionLifecycle([q, user]);
    expect(projected[0]!.metadata).toMatchObject({ widgetDismissed: true });
    expect(projected[0]!.metadata).not.toHaveProperty("respondedValue");
    expect(currentQuestion(projected)).toBeNull();
  }
  expect(q.metadata).not.toHaveProperty("widgetDismissed");
  // A rejected optimistic message disappears: cached question wasn't rewritten.
  expect(currentQuestion([q])?.id).toBe(q.id);
});

test("settled answers survive newer messages, history pages and repeated projections", () => {
  const old = question("1"),
    answered = question("3", { respondedValue: "Blue" });
  const history = [old, message("2", "user"), answered, message("4", "user")];
  const once = projectQuestionLifecycle(history);
  expect(once[0]!.metadata).toHaveProperty("widgetDismissed", true);
  expect(once[2]!.metadata).toHaveProperty("respondedValue", "Blue");
  expect(once[2]!.metadata).not.toHaveProperty("widgetDismissed");
  expect(projectQuestionLifecycle(once)).toEqual(once);
  expect(projectQuestionLifecycle([old, ...once.slice(1)])).toEqual(once);
  expect(currentQuestion([...once, question("5")])?.id).toBe("5");
});

test("branches, other channels, and durable action cards are independent", () => {
  const main = question("1"),
    branch = question("2", { branched: true, questionScopeId: "thread" });
  const draft = message("3", "agent", { type: "external-draft", cardState: "pending" });
  const history = [
    main,
    branch,
    draft,
    message("4", "user", { branched: true, questionScopeId: "thread" }),
  ];
  const projected = projectQuestionLifecycle(history);
  expect(projected[0]).toBe(main);
  expect(projected[1]!.metadata).toHaveProperty("widgetDismissed", true);
  expect(projected[2]).toBe(draft);
  expect(currentQuestion(projected)?.id).toBe(main.id);
  expect(projectQuestionLifecycle([main, { ...message("5", "user"), channelId: "other" }])[0]).toBe(
    main
  );
});

test("a stale server page cannot reopen a settled question or replace its answer", () => {
  for (const settlement of [{ respondedValue: "Blue" }, { widgetDismissed: true }]) {
    const held = question("1", settlement),
      stale = question("1", { reactions: ["new"] });
    const merged = sortedUniqueMessages([held, stale])[0]!;
    expect(merged.metadata).toMatchObject(settlement);
    expect(merged.metadata).toHaveProperty("reactions", ["new"]);
    expect(currentQuestion([merged])).toBeNull();
  }
});

test("a new question retires its predecessor before the older update arrives", () => {
  const older = question("1"), fresh = question("3");
  const projected = projectQuestionLifecycle([older, message("2"), fresh]);
  expect(projected[0]!.metadata).toMatchObject({
    widgetDismissed: true, widgetDismissalReason: "superseded",
  });
  expect(projected[2]).toBe(fresh);
  expect(currentQuestion(projected)?.id).toBe(fresh.id);
  expect(older.metadata).not.toHaveProperty("widgetDismissed");
});

test("a question's chat-list summary is its plain prompt, not its fallback content", () => {
  const asked = question("1");
  asked.metadata = { type: "widget", widget: { type: "choice", prompt: "Which **color**?", helpText: "Choose a sample", options: [{ label: "Red" }] } };
  expect(channelMessageSummary({ ...asked, content: "Fallback content with extra details" })).toBe("Which color?");
});

const page = (messages: ChannelMessageView[], threadContext: ChannelMessageView[] = []): ChannelHistoryPage => ({
  channelId: "chat", messages, threadContext, threadContextTruncated: false,
  beforeSequence: messages[0]?.sequence ?? null, hasMore: true, revision: "1",
});
const settlements = [
  { respondedValue: "Blue", widgetResponseClientId: "answer" },
  { widgetDismissed: true, widgetDismissalReason: "dismissed", widgetDismissClientId: "skip" },
];

test("a known receipt survives stale pages and context from every history lane", () => {
  const lanes = ["messages", "threadContext", "searchContext", "searchThreadContext"] as const;
  for (const settlement of settlements) for (const lane of lanes) {
    const base = { ...emptyLoadedChannelHistory(), loadedAt: 1, [lane]: [question("1", settlement)] };
    for (const mode of ["replace", "refresh", "older"] as const) {
      const next = mergeLoadedChannelHistoryPage(base, page([question("1")]), mode, 2);
      expect(next.messages[0]!.metadata).toMatchObject(settlement);
      expect(currentQuestion(next.messages)).toBeNull();
    }
    const searched = mergeLoadedChannelMessageContext(base, { messages: [question("1")], threadContext: [], threadContextTruncated: false });
    for (const copy of lanes.flatMap(name => searched[name]).filter(row => row.id === "1")) expect(copy.metadata).toMatchObject(settlement);
  }
  // The real store keeps a receipt even after a page that dropped the row, and from thread context too.
  const store = createChannelHistoryStore();
  store.acceptPage(page([question("1", settlements[0])]), "replace");
  store.acceptPage(page([]), "replace");
  store.acceptPage(page([question("1")]), "older");
  expect(store.visible("chat")![0]!.metadata).toMatchObject(settlements[0]!);
  store.acceptPage(page([], [question("2", settlements[1])]), "refresh");
  store.acceptContext({ ...page([question("2")]), beforeSequence: "1", targetMessageId: "2", afterSequence: "1", hasMoreBefore: false, hasMoreAfter: false });
  const kept = (store.retained("chat") ?? []).filter(row => row.id === "2");
  expect(kept.length).toBeGreaterThan(0);
  for (const row of kept) expect(row.metadata).toMatchObject(settlements[1]!);
});

test("accepted server sequence wins over reversed timestamps", () => {
  // A transaction can start earlier but acquire the channel lock and sequence later.
  const q = { ...question("1"), createdAt: "2026-11-14T01:00:00Z" };
  expect(currentQuestion([{ ...message("2", "user"), createdAt: "2026-11-14T00:00:00Z" }, q])).toBeNull();
});

test("receipt retention is bounded and resets with channel/account ownership", () => {
  const receipts = createQuestionReceiptStore(3, 1800);
  for (let i = 0; i < 20; i++) receipts.remember([question(String(i), { respondedValue: "x".repeat(100) })]);
  expect(receipts.size).toBeLessThanOrEqual(3);
  expect(receipts.bytes).toBeLessThanOrEqual(1800);
  expect(receipts.restore(question("19")).metadata).toHaveProperty("respondedValue");
  expect(receipts.restore({ ...question("19"), channelId: "other" }).metadata).not.toHaveProperty("respondedValue");
  for (const reset of ["delete", "clear"] as const) {
    const store = createChannelHistoryStore();
    store.acceptPage(page([question("1", settlements[0])]), "replace");
    if (reset === "delete") store.delete("chat"); else store.clear();
    store.acceptPage(page([question("1")]), "replace");
    expect(currentQuestion(store.visible("chat")!)).not.toBeNull();
  }
});
