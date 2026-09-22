import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { BotView, ChannelMessageView, ChannelView, RunView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { SearchDialog } from "../../src/renderer/components/openteam/search-dialog";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";

window.fetch = async () => {
  throw new Error("No network in parity regression test");
};
Object.assign(api, {
  pluginComposer: async () => ({ items: [] }),
  search: async () => ({ results: [] }),
});
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const root = createRoot(document.getElementById("root")!);
const reports: object[] = [];
const emptyMap = new Map(),
  emptyList: [] = [];
const bots = ["Ada", "Bea", "Cy"].map((name, index) => ({
  id: "bot-" + index,
  name,
  status: "active",
  onboardingStatus: "completed",
  color: ["blue", "purple", "green"][index],
  icon: "chip",
})) as BotView[];
const botById = new Map(bots.map((bot) => [bot.id, bot]));
const runtime = {
  server: "ready",
  database: "ready",
  queue: "ready",
  computer: "ready",
  inference: "ready",
} as const;
const mutate = async <T,>(operation: () => Promise<T>) => operation();
const render = (content: React.ReactNode) =>
  root.render(
    <StrictMode>
      <TooltipProvider>{content}</TooltipProvider>
    </StrictMode>
  );
const editor = () => document.querySelector<HTMLElement>('[role="textbox"][contenteditable]')!;
const type = async (text: string) => {
  check(document.activeElement === editor(), "Typing focus left the composer");
  document.execCommand("insertText", false, text);
  await pause(30);
};
const enter = (composing = false) =>
  editor().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: composing,
    })
  );
async function inputScenario(theme: string) {
  const sent: string[] = [];
  let fail = false,
    hold: (() => void) | undefined,
    block = false,
    open = false;
  const submit = async (value: string) => {
    if (block)
      await new Promise<void>((resolve) => {
        hold = resolve;
      });
    await pause(20);
    if (fail) throw new Error("Controlled failure");
    sent.push(value);
  };
  const draw = () =>
    render(
      <div style={{ width: 745, padding: 16 }}>
        <button id="outside">Another control</button>
        <PromptInput
          onStage={async () => {
            throw new Error("No attachment in this scenario");
          }}
          onSubmit={submit}
        />
        <SearchDialog
          open={open}
          onOpenChange={(value) => {
            open = value;
            draw();
          }}
          actions={[]}
          botById={botById}
          channelById={new Map()}
          onSelectResult={() => {}}
        />
      </div>
    );
  draw();
  await pause(200);
  editor().focus();
  for (const value of ["First", "Second", "Third"]) {
    await type(value);
    enter();
    await pause(80);
  }
  check(sent.join("|") === "First|Second|Third", "Consecutive sends: " + sent);
  await type("Unsent draft");
  enter(true);
  await pause(50);
  check(sent.length === 3 && editor().textContent === "Unsent draft", "IME Enter sent prematurely");
  open = true;
  draw();
  await pause(200);
  check(document.activeElement?.tagName === "INPUT", "Search did not take focus");
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  await type(" retained");
  check(editor().textContent === "Unsent draft retained", "Search did not restore draft focus");
  fail = true;
  enter();
  await pause(100);
  check(
    editor().textContent === "Unsent draft retained" && document.activeElement === editor(),
    "Failure lost draft/focus"
  );
  fail = false;
  block = true;
  enter();
  await pause(50);
  document.querySelector<HTMLElement>("#outside")!.focus();
  hold!();
  await pause(100);
  check(document.activeElement?.id === "outside", "Completion stole focus from another control");
  reports.push({
    theme,
    scenario: "rapid sends, IME, search dismissal, failure recovery, no focus theft",
    sent,
  });
  render(null);
  await pause(50);
}
const message = (
  channelId: string,
  index: number,
  content: string,
  sender: "user" | "agent" = "agent",
  bot = 0
): ChannelMessageView => ({
  id: "message-" + String(999 - index).padStart(4, "0"),
  channelId,
  sequence: String(index + 1),
  sender,
  senderBotId: sender === "agent" ? bots[bot]!.id : null,
  sourceRunId: null,
  content,
  metadata: {},
  createdAt: new Date(Date.now() - 3600000 + index * 1000).toISOString(),
});
let channel: ChannelView,
  messages: ChannelMessageView[],
  runs: RunView[] = [];
let chatWidth = 745;
let hasOlder = false,
  loadingOlder = false;
let loadOlder: (() => Promise<void>) | undefined;
const drawChat = () =>
  render(
    <main style={{ width: chatWidth, height: 850 }}>
      <ChatPane
        key={channel.id}
        channel={channel}
        selectedBot={bots[0]}
        botById={botById}
        agentNameById={emptyMap}
        approvalsByRun={emptyMap}
        itemsByRun={emptyMap}
        capabilities={CLIENT_CAPABILITIES}
        messages={[...messages]}
        runs={runs}
        activeRun={runs[0]}
        subagents={emptyList}
        runtime={runtime}
        mutate={mutate}
        focusMessage={null}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={loadOlder}
      />
    </main>
  );
const newChat = (id: string, kind: "bot_dm" | "group") => {
  channel = {
    id,
    kind,
    name: "Parity fixture",
    members: bots.map((bot, ordinal) => ({ botId: bot.id, ordinal })),
    unreadCount: 0,
    createdAt: new Date(Date.now() - 7200000).toISOString(),
  } as ChannelView;
  chatWidth = 745;
  runs = [];
  hasOlder = false;
  loadingOlder = false;
  loadOlder = undefined;
};
async function chatScenario(theme: string, kind: "bot_dm" | "group") {
  newChat(theme + "-" + kind, kind);
  const at = new Date(Date.now() - 3600000).toISOString();
  messages = ["First", "Second", "Third"].map((text, index) => ({
    ...message(channel.id, index, text),
    createdAt: at,
  }));
  messages.push(
    message(
      channel.id,
      3,
      "A long message to verify the width cap and wrapping. ".repeat(12),
      "user"
    )
  );
  messages.push(message(channel.id, 4, "Hello, parity check passed."));
  messages.push({
    ...message(channel.id, 5, "After the gap"),
    createdAt: new Date().toISOString(),
  });
  drawChat();
  await pause(350);
  const ordered = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].map(
    (node) => node.dataset.messageId
  );
  check(
    ordered.join() === messages.map((row) => row.id).join(),
    "Equal timestamps reordered: " + ordered
  );
  const bubbleFor = (index: number) =>
    document.querySelector<HTMLElement>('[data-message-bubble-id="' + messages[index]!.id + '"]')!;
  const width = bubbleFor(3).getBoundingClientRect().width;
  check(Math.abs(width - 713 * 0.88) < 1, "Long user bubble width " + width + ", expected 627.44");
  const actions = bubbleFor(3).parentElement!.querySelector<HTMLElement>("[data-message-actions]")!;
  const rowBounds = bubbleFor(3).closest(".message-row")!.getBoundingClientRect();
  const actionBounds = actions.getBoundingClientRect();
  check(
    actionBounds.left >= rowBounds.left && actionBounds.right <= rowBounds.right,
    "Hover actions are clipped"
  );
  check(getComputedStyle(actions).position === "absolute", "Actions reserve inline width");
  check(getComputedStyle(actions).transitionDuration === "0s", "Actions wrapper still fades");
  check(
    getComputedStyle(actions.querySelector("button")!).transitionDuration === "0.12s",
    "Button color transition mismatch"
  );
  const time = [...document.querySelectorAll("time")].find(
    (node) => node.dateTime === messages[5]!.createdAt
  )!;
  check(
    time.parentElement!.getBoundingClientRect().height === 50,
    "Timestamp separator is not 50px"
  );
  const greeting = bubbleFor(4);
  const typography = ["optimizeLegibility", "auto", "optimizeSpeed"].map((mode) => {
    greeting.style.textRendering = mode;
    return {
      mode,
      width: greeting.getBoundingClientRect().width,
      font: getComputedStyle(greeting).font,
    };
  });
  greeting.style.textRendering = "";
  runs = bots
    .slice(0, kind === "group" ? 3 : 1)
    .map(
      (bot, index) =>
        ({
          id: "run-" + index,
          botId: bot.id,
          channelId: channel.id,
          status: kind === "group" ? "queued" : "running",
          createdAt: new Date().toISOString(),
        }) as RunView
    );
  drawChat();
  await pause(250);
  check(document.querySelector("[data-bot-thinking] svg"), "Thinking does not render our avatar");
  check(!document.querySelector(".bot-thinking-badge"), "Legacy dot pill remains");
  if (kind === "group")
    check(
      document.querySelector("[data-bot-thinking]")!.textContent?.endsWith("…"),
      "Activity ellipsis missing"
    );
  runs = [];
  drawChat();
  await pause(250);
  check(!document.querySelector("[data-bot-thinking]"), "Thinking did not drain on completion");
  reports.push({
    theme,
    kind,
    scenario: "chronology, geometry, actions, separator, concurrent thinking",
    width,
    typography,
  });
  render(null);
  await pause(50);
}
async function narrowScenario(theme: string) {
  newChat(theme + "-narrow", "group");
  chatWidth = 424;
  messages = [
    message(channel.id, 0, "long message ".repeat(50), "user"),
    message(channel.id, 1, "long reply ".repeat(50)),
  ];
  drawChat();
  await pause(300);
  for (const row of document.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const rowBounds = row.getBoundingClientRect();
    const bubble = row.querySelector<HTMLElement>(".message-bubble")!;
    const bounds = bubble.getBoundingClientRect();
    const actions = row
      .querySelector<HTMLElement>("[data-message-actions]")!
      .getBoundingClientRect();
    check(
      bounds.width === (row.dataset.role === "user" ? 310 : 280),
      "Narrow bubble cap lost its action/gutter allowance"
    );
    check(
      actions.left >= rowBounds.left && actions.right <= rowBounds.right,
      "Narrow hover actions clipped"
    );
    check(bubble.scrollWidth <= bubble.clientWidth, "Narrow text overflows");
  }
  reports.push({ theme, scenario: "narrow direct/user and group/assistant action geometry" });
  render(null);
  await pause(50);
}
async function historyScenario(theme: string) {
  newChat(theme + "-history", "bot_dm");
  messages = Array.from({ length: 120 }, (_, i) =>
    message(
      channel.id,
      i,
      "Earlier message " +
        String(i + 1).padStart(3, "0") +
        ": keep this reading position when new replies arrive.",
      i % 2 ? "agent" : "user"
    )
  );
  hasOlder = true;
  let anchor: { id: string; top: number } | undefined;
  const samples: { time: number; top: number | null; scroll: number; height: number }[] = [];
  const viewport = () => document.querySelector<HTMLElement>(".conversation-scroll")!;
  const topFor = () =>
    anchor
      ? (document
          .querySelector<HTMLElement>('[data-message-id="' + anchor.id + '"]')
          ?.getBoundingClientRect().top ?? null)
      : null;
  loadOlder = async () => {
    await pause(80); // Observe the new virtual window after a large scrollbar jump.
    const bounds = viewport().getBoundingClientRect();
    const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (row) => row.getBoundingClientRect().bottom > bounds.top
    )!;
    anchor = { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
    loadingOlder = true;
    drawChat();
    await pause(500);
    messages = [
      ...Array.from({ length: 25 }, (_, i) => ({
        ...message(channel.id, i - 25, "Older paged " + i),
        createdAt: new Date(Date.now() - 7200000 + i * 1000).toISOString(),
      })),
      ...messages,
    ];
    hasOlder = false;
    loadingOlder = false;
    drawChat();
  };
  drawChat();
  await pause(350);
  viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -6000, bubbles: true }));
  viewport().scrollTop = 454;
  viewport().dispatchEvent(new Event("scroll"));
  const start = performance.now();
  for (let i = 0; i < 70; i++) {
    await pause(50);
    samples.push({
      time: performance.now() - start,
      top: topFor(),
      scroll: viewport().scrollTop,
      height: viewport().scrollHeight,
    });
  }
  check(anchor, "History load was not triggered");
  const settled = samples.filter((sample) => sample.time > 750);
  const drift = Math.max(
    ...settled.map((sample) => (sample.top === null ? 9999 : Math.abs(sample.top - anchor!.top)))
  );
  reports.push({ theme, scenario: "delayed paging anchor", anchor, drift, samples });
  check(drift <= 2, "Delayed history drift " + drift + "px");
  render(null);
  await pause(50);
}
try {
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    await inputScenario(theme);
    for (const kind of ["bot_dm", "group"] as const) await chatScenario(theme, kind);
    await narrowScenario(theme);
    await historyScenario(theme);
  }
  console.log("DESKTOP_PARITY_RESULT " + JSON.stringify({ reports }));
} catch (error) {
  console.log("DESKTOP_PARITY_RESULT " + JSON.stringify({ error: String(error), reports }));
}
