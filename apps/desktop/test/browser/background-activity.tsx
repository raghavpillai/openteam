import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  BotView,
  ChannelMessageView,
  ChannelView,
  RunItemView,
  RunView,
  SubagentActivityView,
} from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";

// No server or desktop bridge: exercise the shipping chat with synthetic activity.
window.fetch = async () => {
  throw new Error("Network disabled in background activity test");
};
const bot = {
  id: "research",
  name: "Research",
  icon: "helmet",
  color: "orange",
  status: "active",
  onboardingStatus: "completed",
} as BotView;
const channel = {
  id: "research-chat",
  kind: "bot_dm",
  name: bot.name,
  members: [{ botId: bot.id, ordinal: 0 }],
  createdAt: new Date().toISOString(),
  unreadCount: 0,
} as ChannelView;
const run = {
  id: "parent-run",
  channelId: channel.id,
  botId: bot.id,
  status: "running",
  createdAt: channel.createdAt,
} as RunView;
const task: SubagentActivityView = {
  id: "attempt",
  subagentId: "child",
  parentBotId: bot.id,
  parentRunId: run.id,
  parentChannelId: channel.id,
  parentToolCallId: "task-call",
  currentRunId: "child-run",
  description: "Refresh the contacts",
  subagentType: "executor",
  runInBackground: true,
  status: "running",
  summary: null,
  errorMessage: null,
  startedAt: channel.createdAt,
  completedAt: null,
  stoppedAt: null,
  createdAt: channel.createdAt,
  updatedAt: channel.createdAt,
};
const messages = [
  {
    id: "ack",
    sequence: "1",
    channelId: channel.id,
    sender: "agent",
    senderBotId: bot.id,
    sourceRunId: run.id,
    content: "I’m refreshing the contact list and statuses from the emails.",
    metadata: {},
    createdAt: channel.createdAt,
  },
] as ChannelMessageView[];
const botById = new Map([[bot.id, bot]]);
const names = new Map([[bot.id, bot.name]]);
const items = new Map<string, RunItemView[]>([
  [
    run.id,
    [
      {
        id: "search",
        runId: run.id,
        kind: "tool",
        status: "running",
        title: null,
        content: { tool: "WebSearch" },
        createdAt: channel.createdAt,
        updatedAt: channel.createdAt,
      },
    ],
  ],
]);
const root = createRoot(document.getElementById("root")!);
let activeRun: RunView | undefined;
let tasks = [task];
const draw = () =>
  root.render(
    <StrictMode>
      <TooltipProvider>
        <main style={{ width: "min(100%, 800px)", height: "100vh", margin: "auto" }}>
          <ChatPane
            channel={channel}
            selectedBot={bot}
            botById={botById}
            agentNameById={names}
            capabilities={CLIENT_CAPABILITIES}
            messages={messages}
            runs={activeRun ? [activeRun] : []}
            activeRun={activeRun}
            subagents={[...tasks]}
            itemsByRun={items}
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
        </main>
      </TooltipProvider>
    </StrictMode>
  );
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const caption = () =>
  document.querySelector('[data-bot-thinking-slot][data-phase="visible"] [role="status"]')
    ?.textContent ?? null;
const reports: string[] = [];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
async function expectCaption(expected: string | null, scenario: string) {
  draw();
  await pause(50);
  let shimmerState: string | undefined;
  for (let i = 0; i < 60; i++) {
    const label = document.querySelector("[data-bot-thinking] .bot-thinking-label");
    const shimmer = label?.querySelector(".bot-activity-shimmer");
    shimmerState = shimmer
      ? reducedMotion
        ? getComputedStyle(shimmer).animationName
        : getComputedStyle(shimmer).animationPlayState
      : undefined;
    // A persistent caption is shown without hover, so its shimmer must run without hover too.
    const readable =
      expected !== "Working in the background" ||
      (label &&
        Number(getComputedStyle(label).opacity) === 1 &&
        shimmerState === (reducedMotion ? "none" : "running"));
    if (caption() === expected && readable) {
      reports.push(scenario);
      return;
    }
    await pause(50);
  }
  throw new Error(
    `${scenario}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(caption())}` +
      (shimmerState ? ` with shimmer ${shimmerState}` : "")
  );
}

if (new URLSearchParams(location.search).has("manual")) draw();
else
  (async () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
      tasks = [task];
      activeRun = run;
      await expectCaption("Searching the web", `${theme}: foreground caption takes priority`);
      activeRun = undefined;
      await expectCaption(
        "Working in the background",
        `${theme}: work remains visible after the main reply`
      );
      for (const status of ["provisioning", "queued", "running"] as const) {
        tasks = [{ ...task, status }];
        await expectCaption(
          "Working in the background",
          `${theme}: ${status} task remains visible`
        );
      }
      tasks = [
        { ...task, status: "completed" },
        { ...task, id: "second", subagentId: "second" },
      ];
      await expectCaption(
        "Working in the background",
        `${theme}: another child keeps the indicator alive`
      );
      for (const status of ["completed", "failed", "stopped"] as const) {
        tasks = [task];
        await expectCaption(
          "Working in the background",
          `${theme}: restarted task becomes visible`
        );
        tasks = [{ ...task, status }];
        await expectCaption(null, `${theme}: ${status} clears the indicator`);
      }
      for (const patch of [
        { parentChannelId: "another-chat" },
        { parentBotId: "another-bot" },
        { runInBackground: false },
      ]) {
        tasks = [{ ...task, ...patch }];
        await expectCaption(null, `${theme}: unrelated or foreground child stays excluded`);
      }
      tasks = [];
      await expectCaption(null, `${theme}: idle conversation stays idle`);
    }
    console.log(
      "BACKGROUND_ACTIVITY_RESULT " + JSON.stringify({ passed: reports.length, reports })
    );
  })().catch((error) =>
    console.log(
      "BACKGROUND_ACTIVITY_RESULT " +
        JSON.stringify({ error: String(error), stack: error.stack, reports })
    )
  );
