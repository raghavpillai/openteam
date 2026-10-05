import type { BotView, ChannelMessageView, ChannelView, ClientSnapshot } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";
import { desktopDurableSendController } from "../../src/renderer/lib/durable-sends";

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
const controller = desktopDurableSendController();
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
  conversationId: "conversation-repro",
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

let phase = "boot";
const frames: unknown[] = [];
const marks: {name: string; time: number}[] = [];
let sampling = true;
function sample() {
  const port = document.querySelector<HTMLElement>(".conversation-scroll");
  const viewport = port?.getBoundingClientRect();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].flatMap(row => {
    const bounds = row.getBoundingClientRect();
    if (!viewport || bounds.bottom < viewport.top || bounds.top > viewport.bottom) return [];
    const content = row.querySelector<HTMLElement>(".message-row-content") ?? row;
    const rich = row.querySelector<HTMLElement>(".rich-message-card");
    const style = getComputedStyle(content);
    return [{ id: row.dataset.messageId, node: nodeId(row), top: bounds.top, height: bounds.height,
      contentTop: content.getBoundingClientRect().top, opacity: style.opacity,
      transform: style.transform, animation: style.animationName,
      richAnimation: rich ? getComputedStyle(rich).animationName : null }];
  });
  frames.push({ time: performance.now(), phase, scroll: port?.scrollTop,
    scrollHeight: port?.scrollHeight, viewportHeight: port?.clientHeight,
    composerHeight: document.querySelector<HTMLElement>("[data-composer-dock]")?.getBoundingClientRect().height,
    rows });
  if (sampling) requestAnimationFrame(sample);
}
requestAnimationFrame(sample);
async function step(name: string, action: () => void | Promise<void>, expected: string[] = []) {
  phase = name;
  marks.push({name, time: performance.now()});
  events.length = 0;
  await action();
  await pause(850);
  const animations = events.filter(e => e.kind.startsWith("animationstart:"));
  const unexpected = animations.filter(e => !expected.some(id =>
    id.endsWith("*") ? (e.id ?? "").startsWith(id.slice(0, -1)) : e.id === id));
  reports.push({name, expected, animations, unexpected,
    scroll: document.querySelector<HTMLElement>(".conversation-scroll")?.scrollTop});
  check(unexpected.length === 0, `${name}: replayed entrance ${JSON.stringify(unexpected)}`);
}
function half() {
  const port = document.querySelector<HTMLElement>(".conversation-scroll")!;
  port.dispatchEvent(new WheelEvent("wheel", { deltaY: -10000, bubbles: true }));
  port.scrollTop = (port.scrollHeight - port.clientHeight) / 2;
  port.dispatchEvent(new Event("scroll"));
}
function realSend(text: string): Promise<void> {
  return new Promise(resolve => {
    (window as any).__inputDone = resolve;
    console.log("FRAME_CHECK_INPUT " + JSON.stringify({text}));
  });
}
let ackCount = 0;
async function dispatch(_target: string, content: string, _files: unknown, _reply: unknown, options: {clientId: string}) {
  const message = { ...messages[198]!, id: `send-${++ackCount}`, clientId: options.clientId,
    sequence: String(messages.length + 1), sender: "user" as const, senderBotId: null,
    content, metadata: {}, createdAt: new Date().toISOString() };
  await pause(400);
  marks.push({name: "server-ack", time: performance.now()});
  messages = [...messages, message];
  render();
  return {message};
}
Object.assign(api, { sendChannelMessage: dispatch, sendMessage: dispatch });
(async () => {
  await controller.restore();
  await step("open-cached-chat", render);
  await step("scroll-halfway", half);
  await step("send-short-halfway", () => realSend("Short send from halfway up"));
  await step("scroll-halfway-again", half);
  await step("receive-reply-halfway", () => {
    messages = [...messages, {...messages[198]!, id: "new-reply", sequence: String(messages.length+1),
      content: "Reply arriving while reading history", metadata: {}, createdAt: new Date().toISOString()}];
    render();
  });
  await step("warm-leave-halfway", () => {active=false; render();});
  await step("warm-reenter-halfway", () => {active=true; render();});
  await step("cold-reopen-chat", () => {visit++; render();});
  await step("latest", () => {
    const port=document.querySelector<HTMLElement>(".conversation-scroll")!;
    port.scrollTop=port.scrollHeight; port.dispatchEvent(new Event("scroll"));
  });
  await step("send-at-latest", () => realSend("Short send while at latest"), ["optimistic:*", "send-2"]);
  await step("receive-rich-at-latest", () => {
    messages = [...messages, {...messages[199]!, id: "new-rich", sequence: String(messages.length+1),
      createdAt: new Date().toISOString()}];
    render();
  }, ["new-rich"]);
  await step("warm-leave-after-send", () => {active=false;render();});
  await step("warm-reenter-after-send", () => {active=true;render();});
  await step("refresh-existing-history", () => {messages=[...messages];render();});
  const lastVisible = (name: string) => (frames as any[]).filter(f => f.phase === name && f.rows.length).at(-1)?.rows;
  const anchor = lastVisible("receive-reply-halfway")?.[0];
  for (const name of ["warm-reenter-halfway", "cold-reopen-chat"]) {
    const restored = lastVisible(name)?.find((r: any) => r.id === anchor?.id);
    check(restored && Math.abs(restored.top-anchor.top) <= 1, `${name}: reading anchor moved`);
  }
  for (const name of ["send-short-halfway", "receive-reply-halfway"]) {
    const phaseFrames = (frames as any[]).filter(f => f.phase === name && f.rows.length);
    const first = phaseFrames[0]?.rows[0];
    const positions = phaseFrames.flatMap(f => f.rows.filter((r: any) => r.id === first?.id).map((r: any) => r.top));
    check(Math.max(...positions)-Math.min(...positions) <= 1, `${name}: visible history jumped`);
  }
  sampling=false;
  console.log("FRAME_CHECK_RESULT " + JSON.stringify({timeOrigin:performance.timeOrigin,kind,theme,reports,marks,frames}));
})().catch(error => {
  sampling=false;
  console.log("FRAME_CHECK_RESULT " + JSON.stringify({error:String(error),timeOrigin:performance.timeOrigin,reports,marks,frames}));
});
