import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { BotView, ChannelMessageView, ChannelView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";
const pause = (ms = 50) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
window.fetch = async () => {
  throw new Error("No external network in widget parity fixture");
};
const bots = ["Parity Probe v3", "New Bot"].map((name, i) => ({
  id: `bot-${i}`,
  name,
  color: i ? "purple" : "blue",
  icon: i ? "pod" : "chip",
  status: "active",
  onboardingStatus: "completed",
})) as BotView[];
const botById = new Map(bots.map((bot) => [bot.id, bot]));
const emptyMap = new Map(),
  emptyList: [] = [];
const runtime = {
  server: "ready",
  database: "ready",
  queue: "ready",
  computer: "ready",
  inference: "ready",
} as const;
let messages: ChannelMessageView[] = [],
  channel: ChannelView,
  width = 745,
  fail = false;
const calls: { id: string; value?: string }[] = [];
const openedExchanges: string[][] = [];
Object.assign(api, {
  pluginComposer: async () => ({ items: [] }),
  respondToWidget: async (id: string, value: string) => reply(id, value),
  dismissWidget: async (id: string) => reply(id),
});
async function reply(id: string, value?: string) {
  calls.push({ id, value });
  await pause(100);
  if (fail) throw new Error("Controlled failure");
  const original = messages.find((message) => message.id === id)!;
  const message = {
    ...original,
    metadata: {
      ...(original.metadata as object),
      ...(value === undefined ? { widgetDismissed: true } : { respondedValue: value }),
    },
  };
  messages = messages.map((row) => (row.id === id ? message : row));
  draw();
  return { accepted: true, message };
}
const root = createRoot(document.getElementById("root")!);
const render = (node: React.ReactNode) =>
  root.render(
    <StrictMode>
      <TooltipProvider>{node}</TooltipProvider>
    </StrictMode>
  );
const draw = () =>
  render(
    <main
      style={{
        width,
        height: new URLSearchParams(location.search).has("manual") ? window.innerHeight : 900,
      }}
    >
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
        runs={emptyList}
        subagents={emptyList}
        runtime={runtime}
        mutate={async (operation) => operation()}
        focusMessage={null}
        onOpenA2A={(source, peer) => openedExchanges.push([source, peer])}
      />
    </main>
  );
const widget = (prompt: string, multiSelect = false) => ({
  type: "widget",
  widget: {
    prompt,
    ...(multiSelect ? { helpText: "Choose any test options." } : {}),
    options: [
      {
        label: "Alpha",
        value: "alpha",
        ...(multiSelect ? { description: "First test option" } : {}),
      },
      {
        label: "Beta",
        value: "beta",
        ...(multiSelect ? { description: "Second test option" } : {}),
      },
      { label: "Gamma", value: "gamma" },
    ],
    multiSelect,
    allowCustom: true,
  },
});
let serial = 0;
function msg(content: string, metadata: object = {}, bot = 0): ChannelMessageView {
  const index = ++serial;
  return {
    id: `widget-message-${index}`,
    channelId: channel.id,
    sequence: String(index),
    sender: "agent",
    senderBotId: bots[bot]!.id,
    sourceRunId: null,
    content,
    metadata,
    createdAt: new Date(Date.now() - 10000 + index * 20).toISOString(),
  };
}
const card = (id: string) =>
  document.querySelector<HTMLElement>(`[data-message-id="${id}"] .permission-widget`)!;
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const button = (id: string, text: string) =>
  [...card(id).querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === text
  )!;
const setInput = async (node: HTMLTextAreaElement, value: string) => {
  node.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
};
const animationEvents: { id: string; name: string; at: number }[] = [];
document.addEventListener("animationstart", (event) => {
  const target = event.target as HTMLElement,
    id = target.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
  if (id)
    animationEvents.push({
      id,
      name: (event as AnimationEvent).animationName,
      at: performance.now(),
    });
});
const reports: object[] = [];
async function scenario(theme: string, kind: "bot_dm" | "group") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  channel = {
    id: `${theme}-${kind}`,
    kind,
    name: "Parity Probe Room",
    members: bots.map((bot, ordinal) => ({ botId: bot.id, ordinal })),
    createdAt: new Date().toISOString(),
  } as ChannelView;
  width = 745;
  messages = Array.from({ length: 14 }, (_, i) =>
    msg(`Earlier message ${i + 1}. ` + "History to check scrollbar width. ".repeat(8))
  );
  draw();
  await pause(250);
  const first = msg("", widget("Widget parity — pick any options", true));
  messages.push(first);
  draw();
  await pause(450);
  const bounds = card(first.id).getBoundingClientRect();
  const available = 745 - 32 - (kind === "group" ? 30 : 0);
  const expected = Math.min(available * 0.88, 640, available - 82);
  check(
    Math.abs(bounds.width - expected) < 1,
    `${kind} ${theme}: widget width ${bounds.width}, expected ${expected}`
  );
  const entrance = animationEvents.filter((item) => item.id === first.id);
  check(
    entrance.length === 1 && entrance[0]!.name === "rich-message-card-enter",
    `Widget has layered entrances: ${JSON.stringify(entrance)}`
  );
  const style = getComputedStyle(card(first.id));
  check(
    style.animationDuration === "0.32s" &&
      style.padding === "12px" &&
      style.borderRadius === "16px",
    "Widget card motion/geometry mismatch"
  );
  console.log(`WIDGET_CAPTURE ${theme}-${kind}-pending`);
  await pause(200);
  const options = card(first.id).querySelectorAll<HTMLButtonElement>("button.widget-option");
  options[0]!.click();
  await pause();
  options[1]!.click();
  await pause();
  check(
    options[0]!.getAttribute("aria-pressed") === "true" &&
      options[1]!.getAttribute("aria-pressed") === "true",
    "Multiselect lost selection"
  );
  check(!!button(first.id, "Submit"), "Selection did not reveal Submit");
  console.log(`WIDGET_CAPTURE ${theme}-${kind}-selected`);
  await pause(200);
  check(
    animationEvents.filter((item) => item.id === first.id).length === 1,
    "Selection replayed card entrance"
  );
  await setInput(
    card(first.id).querySelector("textarea")!,
    "Custom answer\nSecond line\nThird line"
  );
  await pause(150);
  const fieldStyle = getComputedStyle(card(first.id).querySelector(".widget-custom")!);
  check(
    fieldStyle.borderTopColor === (theme === "dark" ? "rgb(28, 139, 254)" : "rgb(12, 100, 193)") &&
      fieldStyle.transitionDuration === "0.12s",
    "Custom answer focus border mismatch"
  );
  render(null);
  await pause();
  draw();
  await pause(400);
  let input = card(first.id).querySelector<HTMLTextAreaElement>("textarea")!;
  check(
    input.value.includes("Third line") && input.clientHeight >= input.scrollHeight,
    `Restored multiline answer clipped: ${input.clientHeight}/${input.scrollHeight}`
  );
  width = 390;
  draw();
  await pause(150);
  input = card(first.id).querySelector<HTMLTextAreaElement>("textarea")!;
  check(input.clientHeight >= input.scrollHeight, "Resizing clipped custom answer");
  check(card(first.id).getBoundingClientRect().right <= width, "Narrow widget overflow");
  width = 745;
  draw();
  await pause(100);
  const before = calls.length;
  button(first.id, "Submit").click();
  button(first.id, "Submit")?.click();
  await pause(450);
  check(calls.length === before + 1, "Double click submitted twice");
  check(
    calls.at(-1)!.value?.includes("alpha") &&
      calls.at(-1)!.value?.includes("beta") &&
      calls.at(-1)!.value?.includes("Third line"),
    "Multi/custom answer not submitted"
  );
  check(card(first.id).dataset.richWidgetState === "resolved", "Widget not resolved");
  const resolved = card(first.id);
  messages = messages.map((message) => ({ ...message }));
  draw();
  await pause(100);
  check(card(first.id) === resolved, "Server echo remounted resolved card");
  console.log(`WIDGET_CAPTURE ${theme}-${kind}-resolved`);
  await pause(200);
  const second = msg("", widget("Group widget parity"), 1),
    third = msg("", widget("Another pending widget"));
  messages.push(second, third);
  draw();
  await pause(400);
  if (kind === "group") {
    check(
      !!row(second.id).querySelector("[data-message-agent-gutter]"),
      "Group widget lost avatar gutter"
    );
    check(row(second.id).textContent?.includes("New Bot"), "Group widget lost sender name");
  }
  const editor = document.querySelector<HTMLElement>('[role="textbox"][contenteditable]')!;
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  await pause();
  check(
    card(third.id).dataset.richWidgetState === "pending",
    "Widget shortcut intercepted composer typing"
  );
  editor.blur();
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true })
  );
  await pause(450);
  check(
    card(third.id).dataset.richWidgetState === "resolved" &&
      card(second.id).dataset.richWidgetState === "pending",
    "Shortcut chose wrong pending card"
  );
  fail = true;
  card(second.id).querySelector<HTMLButtonElement>('[aria-label="Dismiss question"]')!.click();
  await pause(450);
  check(
    card(second.id).dataset.richWidgetState === "pending" &&
      !!card(second.id).querySelector('[role="alert"]'),
    "Failed dismissal lost card"
  );
  fail = false;
  card(second.id).querySelector<HTMLButtonElement>('[aria-label="Dismiss question"]')!.click();
  await pause(450);
  check(card(second.id).dataset.richWidgetState === "dismissed", "Dismiss did not settle");
  reports.push({
    theme,
    kind,
    width: bounds.width,
    entrance,
    checks: [
      "single entrance",
      "multi select/custom",
      "draft remount/resize",
      "single submit/echo",
      "latest shortcut/composer isolation",
      "failure/retry",
      "dismissal",
      "group attribution",
      "narrow layout",
    ],
  });
  console.log(`WIDGET_CAPTURE ${theme}-${kind}`);
  await pause(200);
  if (kind === "bot_dm") {
    messages = [
      msg("Incoming exchange", { fromAgent: { id: bots[1]!.id, name: bots[1]!.name } }),
      msg("Between exchanges"),
      msg("Outgoing exchange", { toAgent: { id: bots[1]!.id, name: bots[1]!.name } }),
    ];
    draw();
    await pause(250);
    let activities = [...document.querySelectorAll<HTMLElement>("[data-a2a-activity]")];
    check(
      activities.length === 2 &&
        activities[0]!.textContent?.startsWith("Message from") &&
        activities[1]!.textContent?.startsWith("Messaged"),
      "Exchange direction labels differ"
    );
    activities[0]!.querySelector<HTMLButtonElement>("button")!.click();
    check(
      openedExchanges.at(-1)?.join() === bots.map((bot) => bot.id).join(),
      "Exchange opens wrong participants"
    );
    messages.splice(1, 1);
    draw();
    await pause(100);
    activities = [...document.querySelectorAll<HTMLElement>("[data-a2a-activity]")];
    check(
      activities.length === 1 && activities[0]!.textContent?.startsWith("2 messages with"),
      "Consecutive exchanges lost aggregation"
    );
  }
}
const manual = new URLSearchParams(location.search).has("manual");
if (manual) {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.classList.add("dark");
  channel = {
    id: "manual-widget",
    kind: "bot_dm",
    name: "Parity Probe v3",
    members: bots.map((bot, ordinal) => ({ botId: bot.id, ordinal })),
    createdAt: new Date().toISOString(),
  } as ChannelView;
  document.getElementById("root")!.style.marginLeft = "240px";
  messages = [
    ...Array.from({ length: 14 }, (_, i) =>
      msg(
        `Earlier parity message ${i + 1}. ` +
          "Layout history for the side-by-side widget capture. ".repeat(4)
      )
    ),
    msg("", widget("Widget parity — pick any options", true)),
  ];
  draw();
} else
  (async () => {
    for (const theme of ["light", "dark"])
      for (const kind of ["bot_dm", "group"] as const) await scenario(theme, kind);
    console.log("DESKTOP_PARITY_RESULT " + JSON.stringify({ passed: reports.length, reports }));
  })().catch((error) =>
    console.log(
      "DESKTOP_PARITY_RESULT " +
        JSON.stringify({ error: String(error), stack: error.stack, reports })
    )
  );
