import type { BotView, ChannelMessageView, ChannelView, ClientSnapshot, RunView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { desktopDurableSendController } from "../../src/renderer/lib/durable-sends";
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
const controller = desktopDurableSendController();
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
    if (!animation.animationName.startsWith("message-row-enter")) return;
    const row = (event.target as Element).closest<HTMLElement>("[data-message-id]");
    if (row)
      events.push({ kind, id: row.dataset.messageId, time: performance.now(), node: nodeId(row) });
  });
}

async function scenario(kind: "bot_dm" | "group", historyCount: number, delay: number) {
  const id = `${document.documentElement.dataset.theme}-${kind}-${historyCount}-${delay}`;
  const now = Date.now();
  const channel = {
    id,
    kind,
    name: "Motion check",
    members: [{ botId: "test-bot", ordinal: 0 }],
    unreadCount: 0,
    createdAt: new Date(now - 60000).toISOString(),
  } as ChannelView;
  const bot = {
    id: "test-bot",
    name: "Motion check",
    status: "active",
    onboardingStatus: "completed",
    color: "blue",
    icon: "chip",
  } as BotView;
  const botById = new Map([[bot.id, bot]]);
  let activeRun: RunView | undefined;
  const messages: ChannelMessageView[] = Array.from({ length: historyCount }, (_, index) => ({
    id: `history-${index}`,
    channelId: id,
    sequence: String(index + 1),
    sender: "agent",
    senderBotId: bot.id,
    sourceRunId: null,
    content: `Earlier message ${index}`,
    metadata: {},
    createdAt: new Date(now - (historyCount - index) * 1000).toISOString(),
  }));
  const render = () =>
    root.render(
      <StrictMode>
        <TooltipProvider>
          <main style={{ height: 700, width: 900 }}>
            <ChatPane
              key={id}
              channel={channel}
              selectedBot={bot}
              botById={botById}
              agentNameById={emptyMap}
              approvalsByRun={emptyMap}
              itemsByRun={emptyMap}
              capabilities={CLIENT_CAPABILITIES}
              messages={[...messages]}
              runs={activeRun ? [activeRun] : emptyList}
              activeRun={activeRun}
              subagents={emptyList}
              runtime={runtime}
              mutate={mutate}
              focusMessage={null}
            />
          </main>
        </TooltipProvider>
      </StrictMode>
    );
  render();
  await pause(300);
  events.length = 0;
  let accept: (() => void) | undefined;
  let echo: ChannelMessageView | undefined;
  const dispatch = async (
    _channel: string,
    content: string,
    _assets: unknown,
    _reply: unknown,
    options: { clientId: string }
  ) => {
    echo = {
      id: `server-${id}`,
      clientId: options.clientId,
      channelId: id,
      sequence: String(historyCount + 1),
      sender: "user",
      senderBotId: null,
      sourceRunId: null,
      content,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    await new Promise<void>((resolve) => {
      accept = resolve;
    });
    return { message: echo };
  };
  Object.assign(api, { sendChannelMessage: dispatch, sendMessage: dispatch });
  await controller.enqueue({
    target: { channelId: id, conversationId: kind === "bot_dm" ? `conversation-${id}` : null },
    payload: { content: "One send, one entrance", attachments: [] },
  });
  await pause(delay);
  check(echo && accept, `${id}: send was not dispatched`);
  const before = document.querySelector<HTMLElement>('[data-role="user"][data-message-id]');
  check(before, `${id}: optimistic message missing`);
  accept!();
  await pause(50);
  // ?legacy reproduces the old bootstrap SQL, which dropped the client ID.
  const { clientId: _clientId, ...bootstrapEcho } = echo!;
  messages.push(new URLSearchParams(location.search).has("legacy") ? bootstrapEcho : echo!);
  render();
  await pause(500);
  const after = document.querySelector<HTMLElement>('[data-role="user"][data-message-id]');
  const starts = events.filter((event) => event.kind === "animationstart");
  const report = { id, starts: starts.length, sameNode: before === after, events: [...events] };
  check(after?.dataset.messageId === echo!.id, `${id}: acknowledgement missing`);
  check(controller.getSnapshot().length === 0, `${id}: journal not reconciled`);
  // Replay the bot path too: thinking starts, a reply arrives, history refreshes,
  // and the run completes. These updates must not remount or reanimate its bubble.
  activeRun = {
    id: `run-${id}`, botId: bot.id, channelId: id, status: "running",
    createdAt: new Date().toISOString(),
  } as RunView;
  render();
  await pause(200);
  const reply: ChannelMessageView = {
    id: `reply-${id}`, channelId: id, sequence: String(historyCount + 2),
    sender: "agent", senderBotId: bot.id, sourceRunId: activeRun.id,
    content: "One reply, one entrance", metadata: {}, createdAt: new Date().toISOString(),
  };
  events.length = 0;
  const frames: { time: number; top: number; scroll: number; thinking: string | null }[] = [];
  const started = performance.now();
  let sampling = true;
  const sample = () => {
    const row = document.querySelector<HTMLElement>(`[data-message-id="${reply.id}"]`);
    if (row) frames.push({ time: performance.now() - started, top: row.getBoundingClientRect().top,
      scroll: document.querySelector(".conversation-scroll")?.scrollTop ?? 0,
      thinking: document.querySelector("[data-bot-thinking-slot]")?.getAttribute("data-phase") ?? null });
    if (sampling) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  messages.push(reply);
  render();
  await pause(50);
  const replyBefore = document.querySelector(`[data-message-id="${reply.id}"]`);
  messages[messages.length - 1] = { ...reply };
  render();
  await pause(delay);
  activeRun = undefined;
  render();
  await pause(500);
  sampling = false;
  const replyAfter = document.querySelector(`[data-message-id="${reply.id}"]`);
  check(replyAfter, `${id}: bot reply missing`);
  const maxLayoutJump = Math.max(0, ...frames.slice(1).map((frame, index) =>
    Math.abs(frame.top - frames[index]!.top)));
  const botReport = { id: `bot-${id}`, starts: events.filter((event) => event.kind === "animationstart").length,
    sameNode: replyBefore === replyAfter, maxLayoutJump, events: [...events], frames };
  return [report, botReport];
}

try {
  await controller.restore();
  const reports = [];
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    for (const kind of ["bot_dm", "group"] as const) {
      for (const count of [0, 1, 100]) {
        for (const delay of [80, 350]) reports.push(...await scenario(kind, count, delay));
      }
    }
  }
  console.log("MESSAGE_MOTION_RESULT " + JSON.stringify({ reports }));
} catch (error) {
  console.log("MESSAGE_MOTION_RESULT " + JSON.stringify({ error: String(error), events }));
}
