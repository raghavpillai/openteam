import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type { BotView, ChannelMessageView, ChannelView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { parsePresentation, presentationFallback } from "@openteam/contracts/presentation";
import fixture from "../../../ios/Tests/CoreTests/Fixtures/presentation.json";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { DesktopHeader } from "../../src/renderer/components/openteam/desktop-header";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { api } from "../../src/renderer/client/openteam-api";
import { setThemePreference } from "../../src/renderer/lib/theme";
import "../../src/renderer/styles.css";

const options = new URLSearchParams(location.search);
setThemePreference(options.has("dark") ? "dark" : "light");
Object.assign(api, { pluginComposer: async () => ({ items: [] }) });
const bot = {
  id: "map-guide",
  name: "Travel",
  color: "blue",
  icon: "chip",
  status: "active",
  onboardingStatus: "completed",
} as BotView;
const channel = {
  id: "map-chat",
  kind: "bot_dm",
  name: "Travel",
  members: [{ botId: bot.id, ordinal: 0 }],
  createdAt: new Date().toISOString(),
} as ChannelView;
const botById = new Map([[bot.id, bot]]),
  emptyMap = new Map(),
  emptyList: [] = [];
const value = structuredClone((window as any).__presentationFixture ?? fixture) as typeof fixture;
const images = (window as any).__presentationImages as string[] | undefined;
const mediaImages = (window as any).__presentationMediaImages as string[] | undefined;
value.places.forEach((place, i) => {
  if (images?.[i]) Object.assign(place, { imageUrl: images[i] });
});
value.blocks[1]!.items!.forEach((item, i) => {
  if (mediaImages?.[i]) Object.assign(item, { imageUrl: mediaImages[i] });
});
const map = parsePresentation({
  ...value,
  blocks: [
    {
      type: "markdown",
      text: "Here’s a relaxed walk through Midtown. Start at the Empire State Building, stop at the library, then finish in Bryant Park.",
    },
    value.blocks[0],
    {
      type: "markdown",
      text: "About 13 minutes of walking, with plenty of time to explore each stop.",
    },
  ],
});
const list = parsePresentation({ ...value, blocks: [value.blocks[1]] });
function msg(
  id: string,
  sender: "user" | "agent",
  content: string,
  metadata: object = {}
): ChannelMessageView {
  return {
    id,
    channelId: channel.id,
    sequence: id.replace(/\D/g, ""),
    sender,
    senderBotId: sender === "agent" ? bot.id : null,
    sourceRunId: null,
    content,
    metadata,
    createdAt: new Date(Date.now() - 180000 + Number(id.replace(/\D/g, "")) * 30000).toISOString(),
  };
}
const messagesFor = (media: boolean) =>
  media
    ? [
        msg("message-1", "user", "Which of those places should I spend the most time at?"),
        msg(
          "message-2",
          "agent",
          "I’d start with the library, then leave time to relax in Bryant Park."
        ),
        msg("message-3", "agent", presentationFallback(list), {
          type: "presentation",
          presentation: list,
        }),
      ]
    : [
        msg(
          "message-1",
          "user",
          "Plan a short walk around Midtown with a few beautiful places to stop."
        ),
        msg("message-2", "agent", presentationFallback(map), {
          type: "presentation",
          presentation: map,
        }),
        msg("message-3", "user", "Perfect. I’ll start at the Empire State Building."),
      ];
function Showcase() {
  const [media, setMedia] = useState(options.has("media"));
  useEffect(() => {
    (window as any).__presentationShowcase = {
      scene: (value: string) => setMedia(value === "media"),
      theme: setThemePreference,
    };
    return () => {
      delete (window as any).__presentationShowcase;
    };
  }, []);
  return (
    <TooltipProvider>
      <main style={{ position: "relative", width: "100%", height: "100dvh" }}>
        <ChatPane
          channel={channel}
          selectedBot={bot}
          botById={botById}
          agentNameById={emptyMap}
          itemsByRun={emptyMap}
          capabilities={CLIENT_CAPABILITIES}
          messages={messagesFor(media)}
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
          inspectorMode="summary"
          inspectorWidth={320}
          onDetailsOpenChange={() => {}}
          onShowSettings={() => {}}
          onShowSummary={() => {}}
        />
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Showcase />);
