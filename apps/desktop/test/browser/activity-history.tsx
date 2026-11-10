import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ChannelClientState, ChannelMessageView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { emptySidebarPreferences } from "@openteam/contracts/client-preferences";
import { api } from "../../src/renderer/client/openteam-api";
import App from "../../src/renderer/App";
import { mobileFixture } from "../../../ios/scripts/fixtures/snapshot";
import "../../src/renderer/styles.css";

// Exercise App -> useOpenTeam -> ChatPane without connecting to a real server.
Object.defineProperty(document, "hidden", { configurable: true, value: true });
window.fetch = async () => {
  throw new Error("Network disabled in activity history fixture");
};
const params = new URLSearchParams(location.search);
const field = params.get("truncated") ?? "runs";
const active = params.has("active");
const bot = { ...mobileFixture.bots[0]!, name: "Finance Guy" };
const channel = { ...mobileFixture.channels[0]!, name: bot.name, unreadCount: 0 };
const messages: ChannelMessageView[] = [
  "Please check this transaction.",
  "I checked the transaction.",
].map((content, i) => ({
  id: `message-${i}`,
  sequence: String(i + 1),
  channelId: channel.id,
  sender: i ? "agent" : "user",
  senderBotId: i ? bot.id : null,
  sourceRunId: null,
  content,
  metadata: {},
  createdAt: channel.createdAt,
}));
const run = {
  ...mobileFixture.runs[0]!,
  id: "active-run",
  channelId: channel.id,
  botId: bot.id,
  status: "running" as const,
  createdAt: channel.createdAt,
};
const state: ChannelClientState = {
  channelId: channel.id,
  revision: "14",
  channelRounds: [],
  subagents: [],
  runs: [
    ...Array.from({ length: active ? 99 : 100 }, (_, index) => ({
      ...run,
      id: `finished-${index}`,
      status: "completed" as const,
    })),
    ...(active ? [run] : []),
  ],
  runItems: [],
  truncated: {
    channelRounds: false,
    runs: false,
    runItems: false,
    subagents: false,
    [field]: true,
  },
};
const snapshot = {
  ...mobileFixture,
  cursor: "14",
  bots: [bot],
  channels: [channel],
  channelMessages: messages,
  runs: state.runs,
  runItems: [],
  subagents: [],
  channelRounds: [],
};
let stateReads = 0;
Object.assign(api, {
  bootstrap: async () => ({
    ...snapshot,
    latestMessages: messages,
    activeRuns: active ? [run] : [],
    capabilities: CLIENT_CAPABILITIES,
  }),
  channelState: async () => {
    stateReads++;
    return state;
  },
  channelHistory: async () => ({
    channelId: channel.id,
    messages,
    threadContext: [],
    threadContextTruncated: params.has("thread"),
    beforeSequence: "1",
    hasMore: false,
    revision: "14",
  }),
  activeAgent: async () => ({ activeAgentId: bot.id }),
  rootSettings: async () => ({
    valid: true,
    settings: { sidebarPreferences: emptySidebarPreferences() },
  }),
  pluginComposer: async () => ({ items: [] }),
  updateNotificationPresence: async () => ({}),
  runtime: async () => ({ runtime: snapshot.runtime }),
});
localStorage.setItem("openteam:selected-channel", channel.id);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

const messagesVisible = () =>
  messages.every((message) => {
    const row = document.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
    return (
      row?.textContent?.includes(message.content) &&
      row.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      row.getBoundingClientRect().height > 0
    );
  });

async function check() {
  for (let i = 0; i < 200; i++) {
    if (
      stateReads &&
      document.querySelector('[data-chat-layout-ready="true"]') &&
      messagesVisible() &&
      Boolean(document.querySelector('[data-bot-thinking-slot][data-phase="visible"]')) === active
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  const text = document.body.textContent ?? "";
  const result = {
    field,
    active,
    stateReads,
    messagesVisible: messagesVisible(),
    banner: text.includes("Older run details are summarized"),
    thinkingVisible: Boolean(
      document.querySelector('[data-bot-thinking-slot][data-phase="visible"]')
    ),
    threadNotice: text.includes("Some older thread context is omitted"),
    thread: params.has("thread"),
  };
  console.log("ACTIVITY_HISTORY_RESULT " + JSON.stringify(result));
}
void check();
