import type {
  BotView,
  ChannelMessageView,
  ChannelView,
  ClientSnapshot,
  RoutineView,
} from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { api } from "../../src/renderer/client/openteam-api";
import { BotAvatarActivityProvider } from "../../src/renderer/components/openteam/bot-avatar-activity";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { DesktopHeader } from "../../src/renderer/components/openteam/desktop-header";
import { Inspector } from "../../src/renderer/components/openteam/inspector";
import { Sidebar } from "../../src/renderer/components/openteam/sidebar";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import type { SidebarPreferencesController } from "../../src/renderer/hooks/use-sidebar-preferences";

// Only synthetic records are supplied. Shipping components, fonts, tokens, and
// CSS render the reference; no auth gate, app controller, or real transport runs.
const noop = () => {};
const noMutation = async (): Promise<never> => {
  throw new Error("This reference is read-only. No server is connected.");
};
const at = new Date();
at.setHours(8, 0, 0, 0);
const timestamp = at.toISOString();
const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000).toISOString();
const botDefinitions = [
  { id: "research", name: "Research", icon: "helmet", color: "orange" },
  { id: "operations", name: "Operations", icon: "pod", color: "purple" },
  { id: "engineering", name: "Engineering", icon: "chip", color: "teal" },
];
const bots: BotView[] = botDefinitions.map((definition) => ({
  ...definition,
  id: `reference-${definition.id}`,
  title: definition.name,
  description: "Synthetic landing-page reference agent",
  instructions: "Use fixture data only.",
  hasAvatar: false,
  notificationsEnabled: true,
  hiddenFromSidebar: false,
  defaultDirectory: "/workspace",
  status: "active",
  onboardingStatus: "completed",
  onboardingVersion: 1,
  onboardingCompletedAt: timestamp,
  provisioningError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  conversationId: `reference-conversation-${definition.id}`,
  dmChannelId: `reference-channel-${definition.id}`,
}));
const channels: ChannelView[] = bots.map((bot) => ({
  id: bot.dmChannelId,
  kind: "bot_dm",
  name: bot.name,
  description: bot.description,
  hasAvatar: false,
  directKey: null,
  workingDirectory: "/workspace",
  members: [{ botId: bot.id, ordinal: 0 }],
  unreadCount: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
}));
const prompts = [
  "Compare these three vendors against our requirements and budget. Check pricing and SSO support. Save a recommendation with source links.",
  "Check our dashboards every morning at 8. Compare uptime and usage with yesterday, and flag changes.",
  "Run the tests, fix the date parser failure, and show me the diff.",
];
const replies = [
  "I compared pricing, SSO support, and fit with your requirements.\n\n**I recommend Northstar.** It meets the requirements and has the lowest annual price.\n\n| Provider | Annual price | SSO |\n| --- | --- | --- |\n| Northstar | $144 | Included |\n| Acme | $216 | Add-on |\n| Orbit | $288 | Included |\n\nSSO is included. The annual price is $72 lower than Acme's.\n\nThe comparison and source notes are saved to `/workspace/reports/vendor-review.md`.",
  "All three services are healthy. API usage is up 12% since yesterday. I saved uptime and usage changes to `/workspace/reports/daily-check.csv`.",
  "The parser returned an invalid Date for empty input. I changed it to return null and added a regression test. All 24 tests pass. The diff is ready for review.",
];
const messages: ChannelMessageView[] = channels.flatMap((channel, index) => [
  {
    id: `${channel.id}-request`,
    sequence: String(index * 2 + 1),
    channelId: channel.id,
    sender: "user",
    senderBotId: null,
    sourceRunId: null,
    content: prompts[index]!,
    metadata: {},
    createdAt: timestamp,
  },
  {
    id: `${channel.id}-result`,
    sequence: String(index * 2 + 2),
    channelId: channel.id,
    sender: "agent",
    senderBotId: bots[index]!.id,
    sourceRunId: null,
    content: replies[index]!,
    metadata: {},
    createdAt: later(3),
  },
]);
const botById = new Map(bots.map((bot) => [bot.id, bot]));
const agentNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
const latestMessageByChannel = new Map(
  messages
    .filter((message) => message.sender === "agent")
    .map((message) => [message.channelId, message])
);
const preferences: SidebarPreferencesController = {
  pinnedIds: new Set(),
  unreadIds: new Set(),
  sections: [{ id: "reference-team", name: "Your team", collapsed: false }],
  sectionByChannel: Object.fromEntries(channels.map((channel) => [channel.id, "reference-team"])),
  unassignedCollapsed: false,
  createSection: () => "reference-team",
  deleteSection: noop,
  markRead: noop,
  markReadMany: noop,
  markUnread: noop,
  markUnreadMany: noop,
  moveChannel: noop,
  moveSection: noop,
  moveToSection: noop,
  renameSection: noop,
  reorderSection: noop,
  togglePinned: noop,
  toggleSection: noop,
  toggleUnassigned: noop,
  toggleUnread: noop,
};
const routine: RoutineView = {
  id: "reference-routine",
  folder: "vendor-check",
  ownerId: bots[0]!.id,
  ownerKind: "bot",
  botId: bots[0]!.id,
  channelId: channels[0]!.id,
  name: "Check vendor pricing",
  prompt: "Check the sample vendors for pricing changes.",
  schedule: "0 8 * * *",
  schedules: ["0 8 * * *"],
  scheduleKind: "cron",
  cronExpression: "0 8 * * *",
  intervalSeconds: null,
  timezone: "America/New_York",
  timezoneMode: "fixed",
  enabled: true,
  revision: 1,
  nextRunAt: later(24 * 60),
  lastRunAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  latestExecution: null,
  triggerPresentation: null,
};
api.routines = async () => [routine];
const runtime: ClientSnapshot["runtime"] = {
  server: "ready",
  database: "ready",
  queue: "ready",
  computer: "ready",
  inference: "ready",
};

function Reference() {
  const [selectedId, setSelectedId] = useState(channels[0]!.id);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const selected = channels.find((channel) => channel.id === selectedId)!;
  const selectedBot = botById.get(selected.members[0]!.botId)!;

  return (
    <BotAvatarActivityProvider channel={selected}>
      <TooltipProvider>
        <main className="flex h-screen overflow-hidden bg-background text-foreground">
          <Sidebar
            activeRunByChannel={new Map()}
            activeTaskChannelIds={new Set()}
            botById={botById}
            channels={channels}
            hiddenAgentCount={0}
            latestMessageByChannel={latestMessageByChannel}
            onBotAction={noop}
            onDeleteChannel={noop}
            onEditChannel={noop}
            onHideChannel={noop}
            onNewBot={noop}
            onNewGroup={noop}
            onOpenAbout={noop}
            onOpenHiddenAgents={noop}
            onOpenPlugins={noop}
            onOpenSettings={noop}
            onPreloadSearch={noop}
            onSearch={noop}
            onSelect={setSelectedId}
            preferences={preferences}
            selectedId={selectedId}
          />
          <section className="relative flex min-w-0 flex-1 flex-col">
            <DesktopHeader
              agentNameById={agentNameById}
              botById={botById}
              detailsOpen={detailsOpen}
              inspectorMode="summary"
              inspectorResizing={false}
              inspectorWidth={320}
              onDetailsOpenChange={setDetailsOpen}
              onShowSettings={noop}
              onShowSummary={noop}
              selected={selected}
              selectedBot={selectedBot}
            />
            <div className="flex min-h-0 flex-1">
              <div className="relative min-w-0 flex-1">
                <ChatPane
                  agentNameById={agentNameById}
                  approvalsByRun={new Map()}
                  botById={botById}
                  capabilities={CLIENT_CAPABILITIES}
                  channel={selected}
                  focusMessage={null}
                  itemsByRun={new Map()}
                  key={selected.id}
                  messages={messages.filter((message) => message.channelId === selected.id)}
                  mutate={noMutation}
                  runs={[]}
                  runtime={runtime}
                  selectedBot={selectedBot}
                  subagents={[]}
                />
              </div>
              {detailsOpen ? (
                <div style={{ position: "relative", width: 320, flexShrink: 0 }}>
                  <Inspector
                    active
                    botById={botById}
                    channel={selected}
                    key={selected.id}
                    mode="summary"
                    onEnableScreen={noop}
                    onModeChange={noop}
                    onOpenTeam={noop}
                    onRetryBot={noMutation}
                    onSetGroupAvatar={noMutation}
                    onSetMembers={noMutation}
                    onUpdateBot={noMutation}
                    onUpdateGroupProfile={noMutation}
                    screenEnabled={false}
                  />
                </div>
              ) : null}
            </div>
          </section>
        </main>
      </TooltipProvider>
    </BotAvatarActivityProvider>
  );
}

if (window.openteam) throw new Error("The desktop reference does not support Electron IPC.");
document.documentElement.dataset.theme = "light";
const root = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => root.unmount());
root.render(<Reference />);
