import { expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { sortedUniqueMessages } from "../src/history";
import { currentQuestion, projectQuestionLifecycle } from "../src/questions";

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
