import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "bun:test";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

test("one bot keeps one append-only Pi session across addressed working directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-pi-session-"));
  temporaryRoots.push(root);
  const sessions = join(root, "sessions");
  const dmDirectory = join(root, "workspace", "bots", "one");
  const groupDirectory = join(root, "workspace", "projects", "room");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(dmDirectory, { recursive: true }),
    mkdir(groupDirectory, { recursive: true }),
  ]);

  const botId = crypto.randomUUID();
  const created = SessionManager.create(dmDirectory, sessions, { id: botId });
  created.appendCustomMessageEntry("openteam-wake", "DM wake", false, { channel: "dm" });
  created.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "DM reply" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionPath = created.getSessionFile();

  expect(sessionPath).toBeString();
  expect(created.getSessionId()).toBe(botId);
  expect(created.getEntries()).toHaveLength(2);

  const groupWake = SessionManager.open(sessionPath!, sessions, groupDirectory);
  expect(groupWake.getSessionId()).toBe(botId);
  expect(groupWake.getCwd()).toBe(groupDirectory);
  expect(groupWake.getEntries()).toHaveLength(2);
  groupWake.appendCustomMessageEntry("openteam-wake", "Group wake", false, {
    channel: "room",
  });

  const reopened = SessionManager.open(sessionPath!, sessions, dmDirectory);
  expect(reopened.getSessionId()).toBe(botId);
  expect(reopened.getSessionFile()).toBe(sessionPath);
  expect(reopened.getEntries()).toHaveLength(3);
  expect(reopened.buildSessionContext().messages).toHaveLength(3);

  const otherBot = SessionManager.create(dmDirectory, sessions, { id: crypto.randomUUID() });
  otherBot.appendCustomMessageEntry("openteam-wake", "Other bot", false);
  otherBot.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Other reply" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  expect(otherBot.getSessionFile()).not.toBe(sessionPath);
});
