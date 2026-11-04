import type { BotView, ChannelMessageView, ChannelView } from "@openteam/contracts";
import { emptySidebarPreferences } from "@openteam/contracts/client-preferences";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { Inspector } from "../../src/renderer/components/openteam/inspector";
import { api } from "../../src/renderer/client/openteam-api";
import { Sidebar } from "../../src/renderer/components/openteam/sidebar";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { useSidebarPreferences } from "../../src/renderer/hooks/use-sidebar-preferences";

// Synthetic roster only: never connect to a user's server or desktop bridge.
window.fetch = async () => {
  throw new Error("Network disabled in sidebar fixture");
};
Object.assign(api, { routines: async () => [] });
const params = new URLSearchParams(location.search);
const count = Number(params.get("count") ?? 40);
localStorage.setItem(
  "openteam:sidebar-preferences",
  JSON.stringify({
    ...emptySidebarPreferences(),
    unreadIds: params.has("read") ? [] : ["channel-2", `channel-${count - 2}`],
  })
);
const channels = Array.from({ length: count }, (_, index) => {
  const date = new Date();
  date.setDate(date.getDate() - index);
  return {
    id: `channel-${index}`,
    name: index === 0 ? "Parity Probe v3" : `Memory Scope ${index}`,
    kind: index === 1 || index === 4 || index === 5 ? "group" : "bot_dm",
    members:
      index === 5
        ? []
        : index === 1
          ? [{ botId: `bot-${index}` }, { botId: `bot-${index + 1}` }]
          : [{ botId: `bot-${index}` }],
    createdAt: date.toISOString(),
    updatedAt: date.toISOString(),
  } as ChannelView;
});
const bots = new Map(
  channels.map((channel, index) => [
    `bot-${index}`,
    {
      id: `bot-${index}`,
      name: channel.name,
      icon: ["hex-visor", "pod", "classic", "terminal"][index % 4],
      color: "#4b8efb",
      status: "active",
      dmChannelId: channel.id,
      conversationId: `conversation-${index}`,
      title: "", description: "", instructions: "",
      notificationsEnabled: true, draftingDisabled: false, draftAllowedRecipients: [],
    } as BotView,
  ])
);
const latest = new Map(
  channels
    .filter((_, index) => index !== 3)
    .map((channel) => [
      channel.id,
      {
        id: `message-${channel.id}`,
        channelId: channel.id,
        content: "Got it: alpha, beta, and Gamma.",
        createdAt: channel.createdAt,
        senderKind: "bot",
        attachments: [],
      } as unknown as ChannelMessageView,
    ])
);
const noop = () => {};
function Fixture() {
  const preferences = useSidebarPreferences();
  if (params.has("settings")) return (
    <TooltipProvider>
      <div style={{ width: 420, height: "100vh" }}>
        <Inspector channel={channels[0]!} botById={bots} active screenEnabled={false} mode="settings"
          onEnableScreen={noop} onModeChange={noop} onUpdateBot={async () => bots.get("bot-0")!}
          onRetryBot={async () => {}} onOpenTeam={noop} onSetGroupAvatar={async () => {}}
          onSetMembers={async () => {}} onUpdateGroupProfile={async () => channels[0]!}
          onBotAction={noop} />
      </div>
    </TooltipProvider>
  );
  return (
    <TooltipProvider>
      <div style={{ display: "flex", height: "100vh" }}>
        <Sidebar
          channels={channels}
          botById={bots}
          latestMessageByChannel={latest}
          activeRunByChannel={new Map()}
          activeTaskChannelIds={new Set()}
          selectedId="channel-0"
          preferences={preferences}
          onPreloadSearch={noop}
          onSearch={noop}
          onSelect={noop}
          onNewBot={noop}
          onNewGroup={noop}
          onOpenPlugins={noop}
          onOpenSettings={noop}
          onBotAction={noop}
          onDeleteChannel={noop}
          onEditChannel={noop}
        />
      </div>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
