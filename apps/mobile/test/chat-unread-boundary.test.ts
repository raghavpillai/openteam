import { expect, test } from "bun:test";
import {
  ChatUnreadBoundary,
  crossesUnreadBoundary,
  unreadChatMessageCount,
} from "../src/chat-unread-boundary";

test("NEW counts message unread state across older and activity-aware snapshots", () => {
  expect(unreadChatMessageCount(undefined)).toBe(0);
  expect(unreadChatMessageCount({ unreadCount: 3 })).toBe(3);
  expect(
    unreadChatMessageCount({ unreadCount: 3, notificationState: { activityUnreadCount: 2 } })
  ).toBe(1);
  expect(
    unreadChatMessageCount({ unreadCount: 0, notificationState: { activityUnreadCount: 2 } })
  ).toBe(0);
});

const message = (sequence: string, sender: "user" | "agent" = "agent", metadata = {}) => ({
  id: sequence,
  sequence,
  sender,
  metadata,
});

test("NEW marks the first incoming reply and survives sending and read acknowledgements", () => {
  const session = new ChatUnreadBoundary(0);
  expect(session.observe([], false)).toBeNull();
  expect(session.observe([], true)).toBeNull();
  const user = message("1", "user");
  expect(session.observe([user], true)).toBeNull();
  const reply = message("2");
  expect(session.observe([user, reply], true)).toBe("2");
  expect(session.observe([user, reply, message("3", "user"), message("4")], true)).toBe("2");
  expect(new ChatUnreadBoundary(0).observe([user, reply], true)).toBeNull();
});

test("opening unread count ignores A2A but includes server-counted events and thread replies", () => {
  const session = new ChatUnreadBoundary(2);
  expect(
    session.observe(
      [
        message("1"),
        message("2", "agent", { type: "event" }),
        message("3", "agent", { fromAgent: { id: "peer" } }),
        message("4", "agent", { toAgent: { id: "peer" } }),
        message("5", "user"),
        message("6", "agent", { replyTo: "1" }),
      ],
      true
    )
  ).toBe("2");
});

test("unloaded unread history waits for the real boundary instead of labeling a newer page", () => {
  const session = new ChatUnreadBoundary(3);
  expect(session.observe([message("9"), message("10")], true)).toBeNull();
  expect(
    session.observe(
      [
        message("6"),
        message("7"),
        message("8", "user"),
        message("9"),
        message("10"),
        message("11"),
      ],
      true
    )
  ).toBe("7");
});

test("search context, pending sends and prepended history cannot create a false NEW marker", () => {
  const session = new ChatUnreadBoundary(0);
  expect(session.observe([message("2")], true, true)).toBeNull();
  expect(session.observe([message("9")], true)).toBeNull();
  expect(
    session.observe([message("2"), message("9"), message("pending", "user")], true)
  ).toBeNull();
  expect(session.observe([message("9"), message("10")], false)).toBeNull();
  expect(session.observe([message("9"), message("10")], true)).toBe("10");
});

test("marker crosses hidden replies once and does not repeat when its page is unloaded", () => {
  expect(crossesUnreadBoundary("1", "3", "2")).toBe(true);
  expect(crossesUnreadBoundary("3", "4", "2")).toBe(false);
  expect(crossesUnreadBoundary(undefined, "4", "2")).toBe(false);
  expect(crossesUnreadBoundary(undefined, "2", "2")).toBe(true);
  expect(crossesUnreadBoundary("9007199254740992", "9007199254740993", "9007199254740993")).toBe(
    true
  );
});
