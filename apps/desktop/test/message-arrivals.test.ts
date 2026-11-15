import { describe, expect, test } from "bun:test";
import { arrivedMessageIds, nextWatchedTranscript } from "../src/renderer/lib/message-arrivals";

const transcript = (...ids: string[]) => ids.map((id) => ({ id }));
const arrivals = (...args: Parameters<typeof arrivedMessageIds>) => [...arrivedMessageIds(...args)];

describe("which messages play the arrival entrance", () => {
  test("a transcript nobody was watching has no arrivals", () => {
    // Opening a chat, or its first history page landing, shows existing messages.
    expect(arrivals(transcript("a", "b", "c"), "chat", null)).toEqual([]);
  });

  test("a message appended below the watched one arrives", () => {
    const watched = { channelId: "chat", latestMessageId: "c" };
    expect(arrivals(transcript("a", "b", "c", "d"), "chat", watched)).toEqual(["d"]);
    expect(arrivals(transcript("a", "b", "c", "d", "e"), "chat", watched)).toEqual(["d", "e"]);
  });

  test("an unchanged newest message means nothing arrived", () => {
    const watched = { channelId: "chat", latestMessageId: "c" };
    expect(arrivals(transcript("a", "b", "c"), "chat", watched)).toEqual([]);
    // Older history loaded above the watched transcript is not an arrival.
    expect(arrivals(transcript("x", "y", "a", "b", "c"), "chat", watched)).toEqual([]);
  });

  test("older messages placed above never arrive alongside a new one", () => {
    const watched = { channelId: "chat", latestMessageId: "c" };
    expect(arrivals(transcript("x", "y", "a", "b", "c", "d"), "chat", watched)).toEqual(["d"]);
  });

  test("a replaced page has no arrivals", () => {
    const watched = { channelId: "chat", latestMessageId: "c" };
    expect(arrivals(transcript("m", "n", "o"), "chat", watched)).toEqual([]);
  });

  test("the first messages of a watched empty chat arrive", () => {
    const watched = { channelId: "chat", latestMessageId: null };
    expect(arrivals(transcript("a"), "chat", watched)).toEqual(["a"]);
    expect(arrivals(transcript(), "chat", watched)).toEqual([]);
  });

  test("another chat's transcript is not a baseline", () => {
    const watched = { channelId: "other", latestMessageId: "c" };
    expect(arrivals(transcript("a", "b", "c", "d"), "chat", watched)).toEqual([]);
  });
});

describe("when a reader starts watching a transcript", () => {
  const messages = transcript("a", "b", "c");
  const watch = (overrides: Partial<Parameters<typeof nextWatchedTranscript>[0]>) =>
    nextWatchedTranscript({ watching: true, behind: false, previous: null, channelId: "chat", messages, ...overrides });

  test("an open, loaded chat at its live edge is watched from its newest message", () => {
    expect(watch({})).toEqual({ channelId: "chat", latestMessageId: "c" });
    expect(watch({ messages: transcript() })).toEqual({ channelId: "chat", latestMessageId: null });
  });

  test("a chat that is not open, still loading or showing history is not watched", () => {
    expect(watch({ watching: false })).toBeNull();
    expect(watch({ watching: false, previous: { channelId: "chat", latestMessageId: "c" } })).toBeNull();
  });

  test("a chat opened before its newest reply was read is not watched until it catches up", () => {
    // The reply already existed when the reader arrived, so it must not arrive.
    expect(watch({ behind: true })).toBeNull();
    const caughtUp = transcript("a", "b", "c", "d");
    expect(arrivals(caughtUp, "chat", watch({ behind: true }))).toEqual([]);
    expect(watch({ messages: caughtUp })).toEqual({ channelId: "chat", latestMessageId: "d" });
  });

  test("a reply heard about while watching still arrives", () => {
    const previous = { channelId: "chat", latestMessageId: "c" };
    const watched = watch({ behind: true, previous });
    expect(watched).toEqual(previous);
    expect(arrivals(transcript("a", "b", "c", "d"), "chat", watched)).toEqual(["d"]);
  });
});
