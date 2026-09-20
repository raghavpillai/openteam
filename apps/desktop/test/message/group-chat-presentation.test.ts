import { expect, test } from "bun:test";
import type { BotView, ChannelMessageView, RunItemView, RunView } from "@openteam/contracts";
import {
  firstUnreadMessageId,
  groupChatActivity,
  groupParticipantNames,
  groupSenderColors,
} from "../../src/renderer/lib/group-chat-presentation";

const bots = new Map(
  ["Ada", "Bea", "Cy", "Dee"].map((name, index) => [
    String(index),
    { id: String(index), name } as BotView,
  ])
);
const run = (id: string, patch: Partial<RunView> = {}) =>
  ({ id, botId: id, status: "running", channelId: "room", ...patch }) as RunView;
const item = (kind: RunItemView["kind"], tool?: string, status = "running") =>
  ({
    id: "item",
    runId: "0",
    kind,
    title: null,
    status,
    content: { tool },
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
  }) as RunItemView;

test("group readers become workers only when their turn starts acting", () => {
  const initial = groupChatActivity([run("0"), run("1", { status: "queued" })], bots, new Map());
  expect(initial.readers.map((bot) => bot.name)).toEqual(["Ada"]);
  expect(initial.workers.map((bot) => bot.name)).toEqual(["Bea"]);
  expect(initial.text).toBe("Bea is working · Ada is reading");
  const tools = new Map([["0", [item("tool", "Read")]]]);
  expect(groupChatActivity([run("0")], bots, tools).readers).toEqual([]);
  const completedTool = new Map([["0", [item("tool", "Read", "completed"), item("reasoning")]]]);
  expect(groupChatActivity([run("0")], bots, completedTool).workers.map((bot) => bot.name)).toEqual(
    ["Ada"]
  );
  // A bounded activity window may evict the earlier tool; the active turn stays committed.
  expect(groupChatActivity([run("0")], bots, new Map(), new Set(["0"])).readers).toEqual([]);
});

test("group activity deduplicates identities, omits completed turns, and keeps reasoning private", () => {
  const items = new Map([
    ["0", [item("tool", "SendToUser")]],
    ["1", [item("reasoning")]],
  ]);
  const activity = groupChatActivity(
    [
      run("0"),
      run("duplicate", { botId: "0" }),
      run("1"),
      run("2", { status: "completed" }),
      run("missing"),
    ],
    bots,
    items
  );
  expect(activity.workers.map((bot) => bot.id)).toEqual(["0"]);
  expect(activity.readers.map((bot) => bot.id)).toEqual(["1"]);
  expect(activity.typing).toBe(true);
  expect(activity.text).toBe("Ada is typing · Bea is reading");
  expect(groupChatActivity([], bots, new Map()).text).toBe("");
});

test("group captions name three participants before abbreviating", () => {
  expect(groupParticipantNames(["Ada"])).toBe("Ada");
  expect(groupParticipantNames(["Ada", "Bea"])).toBe("Ada and Bea");
  expect(groupParticipantNames(["Ada", "Bea", "Cy"])).toBe("Ada, Bea and Cy");
  expect(groupParticipantNames(["Ada", "Bea", "Cy", "Dee"])).toBe("Ada, Bea and 2 others");
});

test("a single working participant retains its tool caption alongside readers", () => {
  const activity = groupChatActivity(
    [run("0"), run("1")],
    bots,
    new Map([["0", [item("tool", "WebSearch")]]])
  );
  expect(activity.text).toBe("Searching the web · Bea is reading");
  expect(activity.workers.map((bot) => bot.name)).toEqual(["Ada"]);
});

test("sender labels use the matching accessible theme palette", () => {
  expect(groupSenderColors("#925df2")).toEqual(["#6e44c1", "#a97efe"]);
  expect(groupSenderColors("green")).toEqual(["#00673a", "#38d591"]);
  expect(groupSenderColors("#F23D52")).toEqual(["#c21d2e", "#ff5667"]);
  expect(groupSenderColors("#a47952")).toEqual(["#734f2e", "#ae8968"]);
  expect(groupSenderColors("not-a-color")).toEqual(groupSenderColors("gray"));
});

test("unread boundary uses exact server sequences and skips outgoing/system messages", () => {
  const message = (id: string, sequence: string, sender: ChannelMessageView["sender"]) =>
    ({ id, sequence, sender }) as ChannelMessageView;
  const messages = [
    message("read", "9007199254740992", "agent"),
    message("mine", "9007199254740993", "user"),
    message("event", "9007199254740994", "system"),
    message("new", "9007199254740995", "agent"),
  ];
  expect(firstUnreadMessageId(messages, "9007199254740992")).toBe("new");
  expect(firstUnreadMessageId(messages, "9007199254740995")).toBeNull();
  expect(firstUnreadMessageId(messages, null)).toBeNull();
  expect(firstUnreadMessageId(messages, "invalid")).toBeNull();
});
