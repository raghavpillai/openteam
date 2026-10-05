import type { BotView, ChannelMessageView, ChannelView, ClientSnapshot } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";

// A disposable Chromium component test. Only the server is substituted; the
// delivery controller, transcript, virtualization and animation CSS are shipped code.
window.fetch = async () => {
  throw new Error("No network in message motion test");
};
Object.assign(api, {
  pluginComposer: async () => ({ items: [] }),
  messageDeliveryStatus: async (_channel: string, clientId: string) => ({
    clientId,
    status: "not_found",
    acceptedAtMs: null,
    message: null,
  }),
});
const root = createRoot(document.getElementById("root")!);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const runtime: ClientSnapshot["runtime"] = {
  server: "ready",
  database: "ready",
  queue: "ready",
  computer: "ready",
  inference: "ready",
};
const emptyMap = new Map();
const emptyList: [] = [];
const mutate = async <T,>(operation: () => Promise<T>) => operation();
const events: { kind: string; id?: string; time: number; node: number }[] = [];
const nodes = new WeakMap<Element, number>();
let nextNode = 0;
function nodeId(node: Element) {
  if (!nodes.has(node)) nodes.set(node, ++nextNode);
  return nodes.get(node)!;
}
for (const kind of ["animationstart", "animationend", "animationcancel"]) {
  document.addEventListener(kind, (event) => {
    const animation = event as AnimationEvent;
    if (!/message-row-enter|rich-message/.test(animation.animationName)) return;
    const row = (event.target as Element).closest<HTMLElement>("[data-message-id]");
    if (row)
      events.push({
        kind: kind + ":" + animation.animationName,
        id: row.dataset.messageId,
        time: performance.now(),
        node: nodeId(row),
      });
  });
}

const options = new URLSearchParams(location.search);
const kind = options.has("group") ? "group" : "bot_dm";
const theme = options.has("dark") ? "dark" : "light";
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");
const Wrapper = options.has("no-strict") ? Fragment : StrictMode;
const reports: unknown[] = [];
const now = Date.now();
const bot = {
  id: "test-bot",
  name: "Animation repro",
  status: "active",
  onboardingStatus: "completed",
  color: "blue",
  icon: "chip",
} as BotView;
const botById = new Map([[bot.id, bot]]);
let active = true;
let visit = 0;
let messages: ChannelMessageView[] = Array.from({ length: 200 }, (_, i) => ({
  id: `history-${i}`,
  channelId: "repro",
  sequence: String(i + 1),
  sender: "agent",
  senderBotId: bot.id,
  sourceRunId: null,
  content: `History ${i}`,
  metadata:
    i === 199
      ? {
          type: "widget",
          widget: {
            prompt: "Existing widget",
            options: [
              { label: "Alpha", value: "alpha" },
              { label: "Beta", value: "beta" },
            ],
          },
        }
      : {},
  createdAt: new Date(now - 60000 + i).toISOString(),
}));
function render() {
  root.render(
    <Wrapper>
      <TooltipProvider>
        <main style={{ height: 700, width: 900 }}>
          <ChatPane
            key={visit}
            active={active}
            channel={
              {
                id: "repro",
                kind,
                name: "Repro",
                members: [{ botId: bot.id, ordinal: 0 }],
                unreadCount: 0,
                createdAt: new Date(now - 60000).toISOString(),
              } as ChannelView
            }
            selectedBot={bot}
            botById={botById}
            agentNameById={emptyMap}
            itemsByRun={emptyMap}
            capabilities={CLIENT_CAPABILITIES}
            messages={messages}
            runs={emptyList}
            subagents={emptyList}
            runtime={runtime}
            mutate={mutate}
            focusMessage={null}
          />
        </main>
      </TooltipProvider>
    </Wrapper>
  );
}
async function step(name: string, action: () => void, expected: string[] = []) {
  events.length = 0;
  action();
  await pause(750);
  const actual = events
    .filter((event) => event.kind.startsWith("animationstart:"))
    .map((event) => event.id)
    .sort();
  check(
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `${name}: expected ${expected}, got ${actual}`
  );
  reports.push({
    name,
    events: [...events],
    mountedMessages: document.querySelectorAll("[data-message-id]").length,
    first: document.querySelector<HTMLElement>("[data-message-id]")?.dataset.messageId,
    scroll: document.querySelector<HTMLElement>(".conversation-scroll")?.scrollTop,
  });
}
function scroll(end: boolean) {
  const port = document.querySelector<HTMLElement>(".conversation-scroll");
  check(port, "scrollport absent");
  port!.dispatchEvent(new WheelEvent("wheel", { deltaY: end ? 10000 : -10000, bubbles: true }));
  port!.scrollTop = end ? port!.scrollHeight : 0;
  port!.dispatchEvent(new Event("scroll"));
}
(async () => {
  await step("open existing history", render, ["history-199"]);
  await step("switch away (warm pane)", () => {
    active = false;
    render();
  });
  await step("switch back (warm pane)", () => {
    active = true;
    render();
  }, ["history-199"]);
  await step("reopen chat (new pane)", () => {
    visit++;
    render();
  }, ["history-199"]);
  await step("scroll away", () => scroll(false));
  await step("scroll back to existing widget", () => scroll(true), ["history-199"]);
  await step("new plain message arrives", () => {
    messages = [
      ...messages,
      {
        ...messages[198]!,
        id: "new-plain",
        sequence: "201",
        content: "Actually new message",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    ];
    render();
  }, ["new-plain"]);
  await step("switch away after arrival", () => {
    active = false;
    render();
  });
  await step("switch back after arrival", () => {
    active = true;
    render();
  }, ["history-199", "new-plain"]);
  await step("scroll away after arrival", () => scroll(false));
  await step("scroll back after arrival", () => scroll(true), ["history-199", "new-plain"]);
  await step("refresh same message list", () => {
    messages = [...messages];
    render();
  });
  await step("switch away after refresh", () => {
    active = false;
    render();
  });
  await step("switch back after refresh", () => {
    active = true;
    render();
  }, ["history-199"]);
  await step("scroll away after refresh", () => scroll(false));
  await step("scroll back after refresh", () => scroll(true), ["history-199"]);
  check(
    document.querySelector('[data-message-id="new-plain"]'),
    "New message must still be displayed"
  );
  console.log(
    "MESSAGE_MOTION_RESULT " +
      JSON.stringify({
        kind,
        theme,
        strict: !options.has("no-strict"),
        assertionsPassed: true,
        reports,
      })
  );
})().catch((error) =>
  console.log("MESSAGE_MOTION_RESULT " + JSON.stringify({ error: String(error), reports }))
);
