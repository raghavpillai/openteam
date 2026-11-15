import { describe, expect, test } from "bun:test";
import type { RunItemView, RunView } from "@openteam/contracts";
import {
  BOT_AVATAR_DONE_MS,
  BOT_AVATAR_FAILED_MS,
  activityAvatarMode,
  createWatchedBotRuns,
  botActivityKind,
  isWaitingOnUser,
  observeSettledRuns,
  resolveBotAvatarMode,
  settledRunKey,
  type SettledBotRun,
} from "../src/bot-avatar";

const activeChannel = { id: "group", members: [{ botId: "one" }, { botId: "two" }] };
const running = { botId: "one", status: "running" } as const;
const item = (overrides: Partial<RunItemView> = {}): RunItemView => ({
  id: "item",
  runId: "run",
  kind: "tool",
  status: "running",
  title: null,
  content: { tool: "Read" },
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
  ...overrides,
});

describe("shared bot avatar activity", () => {
  test("tracks the running bot, not every bot in the active group", () => {
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "one" })).toBe("thinking");
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "two" })).toBe("idle");
  });
  test("idles other conversations without leaking the open chat's activity", () => {
    expect(
      resolveBotAvatarMode({ activeChannel, run: running, botId: "one", channelId: "other" })
    ).toBe("idle");
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "unknown" })).toBe("still");
    expect(resolveBotAvatarMode({ run: running, botId: "one" })).toBe("still");
  });
  test("tracks every working member in background chats independently", () => {
    const runsByChannel = new Map([
      ["background", [running, { botId: "two", status: "queued" } as const]],
      ["resting", [{ ...running, status: "completed" } as const]],
    ]);
    for (const botId of ["one", "two"]) {
      expect(resolveBotAvatarMode({ activeChannel, runsByChannel, botId, channelId: "background" }))
        .toBe("working");
    }
    expect(resolveBotAvatarMode({ activeChannel, runsByChannel, botId: "three", channelId: "background" }))
      .toBe("idle");
    expect(resolveBotAvatarMode({ activeChannel, runsByChannel, botId: "one", channelId: "resting" }))
      .toBe("idle");
    expect(resolveBotAvatarMode({ runsByChannel, botId: "one", channelId: "background" }))
      .toBe("working");
    runsByChannel.set("background", []);
    expect(resolveBotAvatarMode({ activeChannel, run: running, runsByChannel, botId: "one", channelId: "background" }))
      .toBe("idle");
  });
  test("leaves busy modes after a terminal state", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      expect(
        resolveBotAvatarMode({ activeChannel, run: { ...running, status }, botId: "one" })
      ).toBe("idle");
    }
    expect(resolveBotAvatarMode({ activeChannel, botId: "one" })).toBe("idle");
  });
  test("shows what the newest live item is doing", () => {
    const run = { ...running, id: "run" };
    const mode = (items: RunItemView[]) =>
      resolveBotAvatarMode({ activeChannel, run, itemsByRun: new Map([["run", items]]), botId: "one" });
    // Reasoning steps never reach a client, so a run with no live step is thinking.
    expect(mode([])).toBe("thinking");
    expect(mode([item({ kind: "reasoning" })])).toBe("thinking");
    expect(mode([item({ content: { tool: "WebSearch" } })])).toBe("searching");
    expect(mode([item({ content: { tool: "SendToUser" } })])).toBe("typing");
    expect(mode([item({ content: { tool: "GenerateImage" } })])).toBe("generating");
    expect(mode([item({ content: { tool: "CallDynamicTool" } })])).toBe("connecting");
    expect(mode([item({ content: { tool: "AwaitShell" } })])).toBe("connecting");
    expect(mode([item({ content: { tool: "RequestUserForm" } })])).toBe("connecting");
    expect(mode([item({ content: { tool: "Write" } })])).toBe("writing");
    expect(mode([item({ content: { tool: "SendToAgent" } })])).toBe("sending");
    expect(mode([item({ content: { tool: "Task" } })])).toBe("working");
    expect(mode([item({ content: { tool: "browser_click" } })])).toBe("working");
    expect(mode([item({ content: { tool: "Shell" } })])).toBe("working");
    expect(mode([item({ content: { tool: "unknown" } })])).toBe("working");
    // Finished items leave the run thinking until the next step starts.
    expect(mode([item({ status: "completed", content: { tool: "WebSearch" } })])).toBe("thinking");
    expect(
      mode([
        item({ id: "a", content: { tool: "WebSearch" }, createdAt: "2026-11-13T00:00:01.000Z" }),
        item({ id: "b", content: { tool: "Shell" }, createdAt: "2026-11-13T00:00:02.000Z" }),
      ])
    ).toBe("working");
  });
  test("maps every activity to a mode the artwork draws", () => {
    expect(activityAvatarMode(botActivityKind([item({ content: { tool: "WebFetch" } })]))).toBe("working");
    expect(activityAvatarMode("messaging")).toBe("sending");
    expect(activityAvatarMode("delegating")).toBe("working");
    expect(activityAvatarMode("organizing")).toBe("working");
  });
  test("waits on a card the person has not answered yet", () => {
    const card = (metadata: Record<string, unknown>, botId = "one") => ({
      sender: "agent" as const,
      senderBotId: botId,
      metadata,
    });
    expect(isWaitingOnUser(card({ type: "user-form" }), "one")).toBe(true);
    expect(isWaitingOnUser(card({ type: "external-draft", cardState: "pending" }), "one")).toBe(true);
    expect(isWaitingOnUser(card({ type: "external-draft", cardState: "sent" }), "one")).toBe(false);
    expect(isWaitingOnUser(card({ type: "secret-request" }), "one")).toBe(true);
    expect(isWaitingOnUser(card({ type: "secret-request", secretProvided: true }), "one")).toBe(false);
    expect(isWaitingOnUser(card({ type: "widget" }), "one")).toBe(false);
    expect(isWaitingOnUser(card({ type: "user-form" }, "two"), "one")).toBe(false);
    expect(
      resolveBotAvatarMode({ activeChannel, botId: "one", latestMessage: card({ type: "user-form" }) })
    ).toBe("waiting");
    // A new run takes over from the card.
    expect(
      resolveBotAvatarMode({ activeChannel, run: running, botId: "one", latestMessage: card({ type: "user-form" }) })
    ).toBe("thinking");
    // Waiting on the person outranks the outcome of the run that asked.
    expect(
      resolveBotAvatarMode({
        activeChannel,
        botId: "one",
        latestMessage: card({ type: "user-form" }),
        settled: { status: "completed", at: 1000 },
        now: 1500,
      })
    ).toBe("waiting");
  });
  test("holds a watched outcome for eight seconds, then idles", () => {
    expect(BOT_AVATAR_DONE_MS).toBe(8_000);
    expect(BOT_AVATAR_FAILED_MS).toBe(8_000);
    const done: SettledBotRun = { status: "completed", at: 1000 };
    const failed: SettledBotRun = { status: "failed", at: 1000 };
    const at = (settled: SettledBotRun, now: number) =>
      resolveBotAvatarMode({ activeChannel, botId: "one", settled, now });
    expect(at(done, 1000)).toBe("done");
    expect(at(done, 1000 + BOT_AVATAR_DONE_MS - 1)).toBe("done");
    expect(at(done, 1000 + BOT_AVATAR_DONE_MS)).toBe("idle");
    expect(at(failed, 1000 + BOT_AVATAR_FAILED_MS - 1)).toBe("failed");
    expect(at(failed, 1000 + BOT_AVATAR_FAILED_MS)).toBe("idle");
  });
  test("records only finishes it saw happen", () => {
    const watched = createWatchedBotRuns();
    const runs = (status: RunView["status"], id = "r1") =>
      new Map([["chat", [{ id, botId: "one", status }]]]);
    expect(observeSettledRuns(watched, runs("completed"), 1)).toBe(false);
    expect(watched.settled.size).toBe(0);
    expect(observeSettledRuns(watched, runs("running", "r2"), 2)).toBe(false);
    expect(observeSettledRuns(watched, runs("completed", "r2"), 3)).toBe(true);
    expect(watched.settled.get(settledRunKey("chat", "one"))).toEqual({ status: "completed", at: 3 });
    // The next run clears the reaction, and a cancellation never records one.
    expect(observeSettledRuns(watched, runs("running", "r3"), 4)).toBe(true);
    expect(watched.settled.size).toBe(0);
    observeSettledRuns(watched, runs("cancelled", "r3"), 5);
    expect(watched.settled.size).toBe(0);
    expect([...watched.runs.keys()]).toEqual(["r3"]);
  });
  test("counts a vanished background run as done only when the Bot replied", () => {
    const watched = createWatchedBotRuns();
    const reply = new Map([["chat", { sender: "agent" as const, senderBotId: "one" }]]);
    observeSettledRuns(watched, new Map([["chat", [{ id: "r1", botId: "one", status: "running" as const }]]]), 1);
    expect(observeSettledRuns(watched, new Map(), 2, new Map([["chat", { sender: "user" as const, senderBotId: null }]]))).toBe(false);
    expect(watched.settled.size).toBe(0);
    observeSettledRuns(watched, new Map([["chat", [{ id: "r2", botId: "one", status: "running" as const }]]]), 3);
    expect(observeSettledRuns(watched, new Map(), 4, reply)).toBe(true);
    expect(watched.settled.get(settledRunKey("chat", "one"))).toEqual({ status: "completed", at: 4 });
  });
});
