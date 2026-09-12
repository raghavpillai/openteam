import { expect, test } from "bun:test";
import { botAvatarSource } from "../src/bot-avatar-source";

const bot = { id: "copy/id", hasAvatar: true, updatedAt: "2026-09-12T12:00:00Z" };

test("custom avatar fetches use the copy's identity and server-scoped authentication", () => {
  const source = botAvatarSource("https://openbot.test/", bot, "test-session");
  expect(source).toEqual({
    uri: "https://openbot.test/api/v0/bots/copy%2Fid/avatar?v=2026-09-12T12%3A00%3A00Z",
    headers: { Authorization: "Bearer test-session" },
  });
  expect(source?.uri).not.toContain("test-session");
  expect(botAvatarSource("https://openbot.test", bot, null)).not.toHaveProperty("headers");
});

test("shape avatars and fixtures do not request remote images; image revisions invalidate the URL", () => {
  expect(botAvatarSource("", bot, null)).toBeNull();
  expect(botAvatarSource("https://openbot.test", undefined, null)).toBeNull();
  expect(botAvatarSource("https://openbot.test", { ...bot, hasAvatar: false }, null)).toBeNull();
  expect(
    botAvatarSource("https://openbot.test", { ...bot, updatedAt: "later" }, null)?.uri
  ).not.toBe(botAvatarSource("https://openbot.test", bot, null)?.uri);
});
