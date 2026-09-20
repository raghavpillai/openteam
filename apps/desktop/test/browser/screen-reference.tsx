import type {
  BotView,
  ChannelMessageView,
  ChannelView,
  RichMessageComputerHandoffState,
  ScreenStatusView,
} from "@openteam/contracts";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";

// Install isolation before importing any desktop code that can access transport
// or IPC. The frame is embedded and all component API methods below are local.
if (window.openteam) throw new Error("Open this synthetic fixture in a browser, not Electron.");
window.fetch = new Proxy(window.fetch, {
  apply: async () => {
    throw new Error("Network requests are disabled in the computer reference fixture.");
  },
});
window.open = () => null;

const [
  { api },
  { BotScreen },
  { RichMessage },
  { TooltipProvider },
  handoffEvents,
  { DesktopHeader },
] = await Promise.all([
  import("../../src/renderer/client/openteam-api"),
  import("../../src/renderer/components/openteam/bot-screen"),
  import("../../src/renderer/components/openteam/rich-message"),
  import("../../src/renderer/components/ui/tooltip"),
  import("../../src/renderer/lib/computer-handoff"),
  import("../../src/renderer/components/openteam/desktop-header"),
]);

const timestamp = new Date().toISOString();
const bot: BotView = {
  id: "screen-reference-research",
  name: "Research",
  title: "Research",
  description: "Synthetic desktop computer reference",
  instructions: "Use synthetic fixture records only.",
  icon: "helmet",
  color: "orange",
  hasAvatar: false,
  notificationsEnabled: false,
  hiddenFromSidebar: false,
  defaultDirectory: "/workspace",
  status: "active",
  onboardingStatus: "completed",
  onboardingVersion: 1,
  onboardingCompletedAt: timestamp,
  provisioningError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  conversationId: "screen-reference-conversation",
  dmChannelId: "screen-reference-channel",
};

// Neutral placeholder: only the shipping viewer chrome is under comparison.
// A real Linux frame is captured separately; this fixture invents no desktop UI.
const frame = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#303338"/>
  <g font-family="Arial,sans-serif" text-anchor="middle" fill="#a7adb5">
    <text x="640" y="392" font-size="20">Synthetic screen placeholder</text>
    <text x="640" y="426" font-size="14">The surrounding controls are the actual desktop components.</text>
  </g>
</svg>`;
const frameUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(frame)}`;
let screen: ScreenStatusView = {
  botId: bot.id,
  state: "ready",
  width: 1280,
  height: 800,
  display: 1,
  viewerUrl: "",
  humanTakeover: true,
  agentInputPaused: true,
  apps: ["chromium", "thunar", "terminal"],
  browserProfileScope: "computer",
  browserSessionScope: "computer",
  browserSessionMechanism: "shared-profiles",
  browserStateCoverage: ["cookies", "local-storage"],
  browserTargetRouting: "bot-owned-tabs",
};
const messageId = "screen-reference-handoff";
const messageFor = (state: RichMessageComputerHandoffState): ChannelMessageView => ({
  id: messageId,
  sequence: "1",
  channelId: bot.dmChannelId,
  sender: "agent",
  senderBotId: bot.id,
  sourceRunId: null,
  content: "Sign in to Northstar so I can check the account's pricing and SSO settings.",
  metadata: {
    type: "computer-handoff",
    computerHandoff: {
      reason: "Sign in to Northstar so I can check the account's pricing and SSO settings.",
    },
    computerHandoffState: state,
  },
  createdAt: timestamp,
});
const mutationEvent = "screen-reference:handoff-state";
api.screenStatus = async () => screen;
api.screenFrameUrl = () => frameUrl;
api.screenAction = async () => screen;
api.screenTakeover = async (_botId, active) => {
  screen = { ...screen, humanTakeover: active, agentInputPaused: active };
  return screen;
};
api.releaseScreenTakeover = () => {};
api.releaseComputerHandoff = () => {};
api.mutateComputerHandoff = async (_id, action) => {
  const state = {
    start: "active",
    complete: "completed",
    skip: "skipped",
    dismiss: "dismissed",
  }[action] as RichMessageComputerHandoffState;
  window.dispatchEvent(new CustomEvent(mutationEvent, { detail: state }));
  return { accepted: true, message: messageFor(state), runId: null };
};

function Reference() {
  const inspector = new URLSearchParams(window.location.search).has("inspector");
  const initialHandoff = new URLSearchParams(window.location.search).get("state") !== "card";
  const [detailsOpen, setDetailsOpen] = useState(initialHandoff);
  const [screenEnabled, setScreenEnabled] = useState(initialHandoff);
  const [handoff, setHandoff] = useState(initialHandoff ? { botId: bot.id, messageId } : null);
  const [handoffState, setHandoffState] = useState<RichMessageComputerHandoffState>(
    initialHandoff ? "active" : "requested"
  );
  const onEnable = useCallback(() => {}, []);
  useEffect(() => {
    const receiveOpen = () => setHandoff({ botId: bot.id, messageId });
    const receiveState = (event: Event) =>
      setHandoffState((event as CustomEvent<RichMessageComputerHandoffState>).detail);
    window.addEventListener(handoffEvents.COMPUTER_HANDOFF_OPEN_EVENT, receiveOpen);
    window.addEventListener(mutationEvent, receiveState);
    return () => {
      window.removeEventListener(handoffEvents.COMPUTER_HANDOFF_OPEN_EVENT, receiveOpen);
      window.removeEventListener(mutationEvent, receiveState);
    };
  }, []);

  if (inspector) {
    const channel: ChannelView = {
      id: bot.dmChannelId,
      kind: "bot_dm" as const,
      name: bot.name,
      description: "",
      hasAvatar: false,
      directKey: `bot:${bot.id}`,
      workingDirectory: bot.defaultDirectory,
      unreadCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [{ botId: bot.id, ordinal: 0 }],
    };
    return (
      <TooltipProvider>
        <main className="relative flex h-screen flex-col bg-background text-foreground">
          <DesktopHeader
            agentNameById={new Map([[bot.id, bot.name]])}
            botById={new Map([[bot.id, bot]])}
            detailsOpen={detailsOpen}
            inspectorWidth={320}
            inspectorMode="summary"
            selected={channel}
            selectedBot={bot}
            onDetailsOpenChange={setDetailsOpen}
            onShowSettings={() => {}}
            onShowSummary={() => {}}
          />
          <div className="flex min-h-0 flex-1">
            <div className="flex-1 p-6">Computer control regression fixture</div>
            {detailsOpen && (
              <section
                aria-label="Conversation details"
                className="shrink-0 overflow-hidden"
                style={{ width: 320 }}
              >
                {/* Match App's animated inspector: a transform establishes the fixed-position containing block. */}
                <div className="relative h-full" style={{ width: 320, transform: "translateX(0)" }}>
                  <aside className="flex size-full flex-col px-4 pb-5 pt-11">
                    <BotScreen
                      active
                      bot={bot}
                      enabled={screenEnabled}
                      handoff={handoff}
                      onEnable={() => setScreenEnabled(true)}
                      onHandoffFinished={() => setHandoff(null)}
                    />
                    <p className="mt-2 text-center text-xs">Research's screen</p>
                  </aside>
                </div>
              </section>
            )}
          </div>
        </main>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <main style={{ maxWidth: 760, margin: "64px auto", padding: 24 }}>
        <p style={{ fontSize: 12, color: "#757575", marginBottom: 16 }}>
          Actual desktop components · Synthetic screen and handoff
        </p>
        <div style={{ maxWidth: 540, marginBottom: 28 }}>
          <RichMessage message={messageFor(handoffState)} />
        </div>
        <div style={{ width: 296 }}>
          <BotScreen
            active
            bot={bot}
            enabled
            handoff={handoff}
            onEnable={onEnable}
            onHandoffFinished={() => setHandoff(null)}
          />
          <p style={{ marginTop: 8, fontSize: 12, textAlign: "center", color: "#757575" }}>
            Research's screen
          </p>
        </div>
        <p style={{ marginTop: 28, fontSize: 12, color: "#757575" }}>
          <a href="?state=card">Reset to request card</a> ·{" "}
          <a href="?state=handoff">Open handoff viewer</a>
        </p>
      </main>
    </TooltipProvider>
  );
}

document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "light";
const root = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => root.unmount());
root.render(<Reference />);

// Self-running Chromium geometry check; normal reference controls remain manual.
if (new URLSearchParams(location.search).has("regression")) {
  let attempts = 0;
  const measure = () => {
    const close = document.querySelector('[aria-label="Close computer view"]');
    const overlay = close?.closest<HTMLElement>(".fixed");
    if (!overlay && attempts++ < 180) return requestAnimationFrame(measure);
    if (!overlay) {
      console.log("COMPUTER_VIEW_RESULT " + JSON.stringify({ error: "Computer did not open" }));
      return;
    }
    const bounds = overlay.getBoundingClientRect();
    console.log(
      "COMPUTER_VIEW_RESULT " +
        JSON.stringify({
          theme: document.documentElement.dataset.theme,
          viewport: { width: innerWidth, height: innerHeight },
          overlay: {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
          },
          fullWindow:
            bounds.left === 0 &&
            bounds.top === 0 &&
            bounds.width === innerWidth &&
            bounds.height === innerHeight,
        })
    );
  };
  requestAnimationFrame(measure);
}
