// Shipping header, transcript, bubbles and styles; synthetic data only.
import type { BotView, ChannelMessageView, ChannelView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { DesktopHeader } from "../../src/renderer/components/openteam/desktop-header";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";

window.fetch = async () => {
  throw new Error("Network disabled in gradient fixture");
};
api.pluginComposer = async () => ({ items: [] });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const long = params.has("long");
const bot = {
  id: "gradient-bot",
  name: "Chief of Staff",
  status: "active",
  onboardingStatus: "completed",
  icon: "classic",
} as BotView;
const channel = {
  id: "gradient-chat",
  kind: "bot_dm",
  name: bot.name,
  members: [{ botId: bot.id, ordinal: 0 }],
  createdAt: "2026-11-10T09:54:00Z",
} as ChannelView;
const botById = new Map([[bot.id, bot]]);
const emptyMap = new Map();
const emptyList: [] = [];
const messages = Array.from({ length: long ? 30 : 18 }, (_, index) => ({
  id: `gradient-${index}`,
  channelId: channel.id,
  sequence: String(index + 1),
  sender: index % 3 === 0 ? "user" : "agent",
  senderBotId: index % 3 === 0 ? null : bot.id,
  sourceRunId: null,
  metadata: {},
  createdAt: "2026-11-10T09:54:00Z",
  content: long
    ? `Message ${index}. ${"Checking that messages fade smoothly beneath the conversation header. ".repeat(18)}`
    : [
        "Can you go through my Instagram and find all my saved reels?",
        "I’ll check your Instagram saves and collect the reel links into a list.",
        "Instagram failed to load twice with “connection reset,” so I couldn’t reach the saved reels.",
      ][index % 3],
})) as ChannelMessageView[];
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <main className="relative flex h-full flex-col">
        <ChatPane
          channel={channel}
          selectedBot={bot}
          botById={botById}
          agentNameById={emptyMap}
          itemsByRun={emptyMap}
          capabilities={CLIENT_CAPABILITIES}
          messages={messages}
          runs={emptyList}
          subagents={emptyList}
          runtime={{
            server: "ready",
            database: "ready",
            queue: "ready",
            computer: "ready",
            inference: "ready",
          }}
          mutate={async (operation) => operation()}
          focusMessage={null}
        />
        <DesktopHeader
          selected={channel}
          selectedBot={bot}
          botById={botById}
          agentNameById={emptyMap}
          detailsOpen={false}
          inspectorWidth={360}
          inspectorMode="summary"
          onDetailsOpenChange={() => {}}
          onShowSummary={() => {}}
        />
      </main>
    </TooltipProvider>
  </StrictMode>
);
