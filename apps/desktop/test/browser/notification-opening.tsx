import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ChannelMessageView } from "@openteam/contracts";
import type { ProductEventHandlers } from "@openteam/client-core";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { emptySidebarPreferences } from "@openteam/contracts/client-preferences";
import { mobileFixture } from "../../../ios/scripts/fixtures/snapshot";
import { api, openTeamClient } from "../../src/renderer/client/openteam-api";
import App from "../../src/renderer/App";
import "../../src/renderer/styles.css";

const original = structuredClone(mobileFixture);
const channel = original.channels[0]!;
const other = original.channels[1]!;
const template = original.channelMessages[0]!;
const makeMessage = (number: number): ChannelMessageView => ({
  ...template,
  id: `notice-${number}`,
  sequence: String(number),
  channelId: channel.id,
  content: `Notification message ${number}`,
  metadata: {},
  createdAt: new Date(1700000000000 + number * 1000).toISOString(),
});
const messages = Array.from({ length: 180 }, (_, index) => makeMessage(index + 1));
messages.push({
  ...template,
  id: "other-message",
  sequence: "181",
  channelId: other.id,
  content: "Other conversation stays readable",
  metadata: {},
});
let cursor = 10;
const parameters = new URLSearchParams(location.search);
document.documentElement.dataset.theme = parameters.get("theme") ?? "dark";
Object.defineProperty(document, "hidden", { configurable: true, value: true });
Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
localStorage.clear();
localStorage.setItem("openteam:selected-channel", other.id);
const calls: Array<{
  kind: string;
  channelId?: string;
  messageId?: string;
  sequence?: string;
  activity?: string;
  at: number;
}> = [];
const bridgeTargets: unknown[] = [];
let contextDelay = 0;
let historyDelay = 0;
let stateDelay = 0;
let contextFailures = 0;
let activityUnreadCount = 0;
let unreadCount = 180;
let eventHandlers: ProductEventHandlers | undefined;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (id: string) => ({
  channelId: id,
  revision: String(cursor),
  channelRounds: [],
  runs: [],
  runItems: [],
  subagents: [],
  truncated: { runs: false, runItems: false, subagents: false, channelRounds: false },
});
const bootstrap = () => ({
  ...original,
  cursor: String(cursor),
  capabilities: CLIENT_CAPABILITIES,
  channels: original.channels.map((c) => ({
    ...c,
    unreadCount: c.id === channel.id ? unreadCount : 0,
    notificationState: {
      channelId: c.id,
      lastReadSequence: "0",
      lastReadNotificationSequence: "0",
      notificationCursor: String(cursor),
      notifications: [],
      activityUnreadCount: c.id === channel.id ? activityUnreadCount : 0,
    },
  })),
  latestMessages: original.channels.flatMap((c) =>
    messages.filter((m) => m.channelId === c.id).slice(-1)
  ),
  activeRuns: [],
});
window.fetch = async (input) => {
  const path = String(input);
  if (path.includes("notification-presence") || path.includes("time-zone"))
    return Response.json({});
  throw new Error(`Unexpected network access in isolated fixture: ${path}`);
};
openTeamClient.listenForEvents = async (_after, handlers, signal) => {
  eventHandlers = handlers;
  handlers.onOpen?.();
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
};
Object.assign(api, {
  bootstrap: async () => bootstrap(),
  rootSettings: async () => ({
    valid: true,
    settings: { sidebarPreferences: emptySidebarPreferences() },
  }),
  updateSidebarPreferences: async (value: unknown) => value,
  activeAgent: async () => ({ activeAgentId: null }),
  setActiveAgent: async () => ({}),
  updateUserTimeZone: async () => ({}),
  pluginComposer: async () => ({ items: [] }),
  routines: async () => [],
  plugins: async () => [],
  channelState: async (id: string) => {
    await pause(stateDelay);
    return state(id);
  },
  channelHistory: async (id: string, options: { beforeSequence?: string; limit?: number } = {}) => {
    calls.push({ kind: "history", channelId: id, at: performance.now() });
    const rows = structuredClone(
      messages.filter(
        (m) =>
          m.channelId === id &&
          (!options.beforeSequence || BigInt(m.sequence!) < BigInt(options.beforeSequence))
      )
    );
    const page = rows.slice(-(options.limit ?? 60));
    await pause(historyDelay);
    return {
      channelId: id,
      messages: page,
      threadContext: [],
      threadContextTruncated: false,
      hasMore: page.length < rows.length,
      beforeSequence: page[0]?.sequence ?? null,
      revision: String(cursor),
    };
  },
  messageContext: async (id: string) => {
    calls.push({ kind: "context", messageId: id, at: performance.now() });
    await pause(contextDelay);
    if (contextFailures-- > 0) throw new Error("Simulated context outage");
    const target = messages.find((m) => m.id === id);
    if (!target) throw new Error("Message is unavailable");
    const rows = messages.filter((m) => m.channelId === target.channelId);
    const index = rows.findIndex((m) => m.id === id);
    const start = Math.max(0, index - 20);
    const end = Math.min(rows.length, index + 21);
    const page = rows.slice(start, end);
    return {
      channelId: target.channelId,
      targetMessageId: id,
      messages: structuredClone(page),
      threadContext: [],
      threadContextTruncated: false,
      beforeSequence: page[0]?.sequence ?? null,
      afterSequence: page.at(-1)?.sequence ?? null,
      hasMoreBefore: start > 0,
      hasMoreAfter: end < rows.length,
      revision: String(cursor),
    };
  },
  markChannelRead: async (id: string, sequence?: string, activity?: string) => {
    calls.push({ kind: "read", channelId: id, sequence, activity, at: performance.now() });
    return {
      channelId: id,
      lastReadSequence: sequence ?? "0",
      lastReadNotificationSequence: activity ?? "0",
      unreadCount: 0,
    };
  },
});
window.openteam!.onNotificationClick((target) => bridgeTargets.push(target));
Object.assign(window, {
  notificationFixture: {
    channelId: channel.id,
    otherId: other.id,
    calls,
    bridgeTargets,
    prepareThread(numbers: number[], root = 24) {
      for (const number of numbers) {
        const message = messages.find((candidate) => candidate.id === `notice-${number}`);
        if (message) message.metadata = { branched: true, replyTo: `notice-${root}` };
      }
    },
    control(value: {
      contextDelay?: number;
      historyDelay?: number;
      stateDelay?: number;
      contextFailures?: number;
    }) {
      contextDelay = value.contextDelay ?? contextDelay;
      historyDelay = value.historyDelay ?? historyDelay;
      stateDelay = value.stateDelay ?? stateDelay;
      contextFailures = value.contextFailures ?? contextFailures;
    },
    reaction() {
      unreadCount = 0;
      activityUnreadCount = 1;
      cursor++;
      eventHandlers?.onEvent({
        sequence: String(cursor),
        topic: "channel-message.reacted",
        entityId: channel.id,
        createdAt: new Date().toISOString(),
        payload: {},
      });
    },
    announce(number: number, legacy = false, threaded = false, threadRoot = 24) {
      const id = `notice-${number}`;
      let target = messages.find((m) => m.id === id);
      if (!target) {
        target = makeMessage(number);
        messages.push(target);
      }
      if (threaded) target.metadata = { branched: true, replyTo: `notice-${threadRoot}` };
      cursor++;
      const projection = bootstrap().channels.map((c) => ({
        ...c.notificationState,
        unreadCount: c.unreadCount,
        notifications:
          c.id === channel.id
            ? [
                {
                  kind: "message",
                  channelId: c.id,
                  botId: channel.members[0]!.botId,
                  messageSequence: target.sequence!,
                  ...(legacy ? {} : { messageId: id }),
                  ...(threaded ? { threadMessageId: id } : {}),
                  notificationSequence: String(cursor),
                  title: channel.name,
                  body: target.content,
                },
              ]
            : [],
      }));
      window.openteam!.notifications.sync({ cursor: String(cursor), channels: projection });
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
