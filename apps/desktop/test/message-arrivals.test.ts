import { expect, test } from "bun:test";
import { arrivedMessageIds, nextWatchedTranscript } from "../src/renderer/lib/message-arrivals";

const transcript = (...ids: string[]) => ids.map((id) => ({ id }));
const arrivals = (...args: Parameters<typeof arrivedMessageIds>) => [...arrivedMessageIds(...args)];

test("only messages appended below the watched newest message arrive", () => {
  const watched = { channelId: "chat", latestMessageId: "c" };
  // Opening a chat, or its first history page landing, shows existing messages.
  expect(arrivals(transcript("a", "b", "c"), "chat", null)).toEqual([]);
  expect(arrivals(transcript("a", "b", "c", "d", "e"), "chat", watched)).toEqual(["d", "e"]);
  expect(arrivals(transcript("a", "b", "c"), "chat", watched)).toEqual([]);
  // Older history placed above is never an arrival, even alongside a new message.
  expect(arrivals(transcript("x", "y", "a", "b", "c", "d"), "chat", watched)).toEqual(["d"]);
  expect(arrivals(transcript("m", "n", "o"), "chat", watched)).toEqual([]);
  expect(arrivals(transcript("a", "b", "c", "d"), "chat", { channelId: "other", latestMessageId: "c" })).toEqual([]);
  expect(arrivals(transcript("a"), "chat", { channelId: "chat", latestMessageId: null })).toEqual(["a"]);
});

test("a chat is watched only while open at its live edge, so replies that were already there never arrive", () => {
  const messages = transcript("a", "b", "c");
  const watch = (overrides: Partial<Parameters<typeof nextWatchedTranscript>[0]>) =>
    nextWatchedTranscript({ watching: true, behind: false, previous: null, channelId: "chat", messages, ...overrides });
  expect(watch({})).toEqual({ channelId: "chat", latestMessageId: "c" });
  expect(watch({ watching: false, previous: { channelId: "chat", latestMessageId: "c" } })).toBeNull();
  // Opened before its newest reply was read: not watched until it catches up.
  expect(watch({ behind: true })).toBeNull();
  const caughtUp = transcript("a", "b", "c", "d");
  expect(arrivals(caughtUp, "chat", watch({ behind: true }))).toEqual([]);
  // A reply heard about while already watching still arrives.
  const previous = { channelId: "chat", latestMessageId: "c" };
  expect(arrivals(caughtUp, "chat", watch({ behind: true, previous }))).toEqual(["d"]);
});
