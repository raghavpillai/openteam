import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { BotView, ChannelMessageView, ChannelView, MessageDeliveryStatusView, RunView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { DURABLE_SEND_ACK_TIMEOUT_MS, durableSendMessage, type DurableSendRecord } from "@openteam/product-core/durable-delivery";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { SearchDialog } from "../../src/renderer/components/openteam/search-dialog";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { ExternalDraftCard } from "../../src/renderer/components/openteam/external-draft-card";
import { ThreadTray } from "../../src/renderer/components/openteam/thread-tray";
import { desktopDurableSendController } from "../../src/renderer/lib/durable-sends";
import { parseExternalDraft } from "@openteam/contracts/external-draft";
import "../../src/renderer/styles.css";

// Composer focus/IME, chat ordering and thinking, history anchoring, email draft review, and
// the delivery lifecycle of sent messages, on production components with a controlled API.
window.fetch = async () => {
  throw new Error("No network in parity regression test");
};
// Only the send lifecycle moves this clock, to expire acknowledgements.
const wallNow = Date.now;
let clockOffset = 0;
Date.now = () => wallNow() + clockOffset;
Object.assign(api, {
  pluginComposer: async () => ({ items: [] }),
  search: async () => ({ results: [] }),
});
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const root = createRoot(document.getElementById("root")!);
const reports: string[] = [];
const emptyMap = new Map(), emptyList: [] = [];
const bots = ["Ada", "Bea", "Cy"].map((name, index) => ({
  id: "bot-" + index,
  conversationId: "conversation-" + index,
  name,
  status: "active",
  onboardingStatus: "completed",
  color: ["blue", "purple", "green"][index],
  icon: "chip",
})) as BotView[];
const botById = new Map(bots.map((bot) => [bot.id, bot]));
const runtime = { server: "ready", database: "ready", queue: "ready", computer: "ready", inference: "ready" } as const;
const mutate = async <T,>(operation: () => Promise<T>) => operation();
const render = (content: React.ReactNode) => root.render(<StrictMode><TooltipProvider>{content}</TooltipProvider></StrictMode>);
const editor = () => document.querySelector<HTMLElement>('[role="textbox"][contenteditable]')!;
const type = async (text: string) => {
  check(document.activeElement === editor(), "Typing focus left the composer");
  document.execCommand("insertText", false, text);
  await pause(30);
};
const enter = (composing = false) =>
  editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: composing }));
async function inputScenario() {
  const sent: string[] = [];
  let fail = false, block = false, open = false;
  let hold: (() => void) | undefined;
  const submit = async (value: string) => {
    if (block) await new Promise<void>((resolve) => (hold = resolve));
    await pause(20);
    if (fail) throw new Error("Controlled failure");
    sent.push(value);
  };
  const draw = () =>
    render(
      <div style={{ width: 745, padding: 16 }}>
        <button id="outside">Another control</button>
        <PromptInput onStage={async () => { throw new Error("No attachment in this scenario"); }} onSubmit={submit} />
        <SearchDialog open={open} onOpenChange={(value) => { open = value; draw(); }} actions={[]} botById={botById} channelById={new Map()} onSelectResult={() => {}} />
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
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await type(" retained");
  check(editor().textContent === "Unsent draft retained", "Search did not restore draft focus");
  fail = true;
  enter();
  await pause(100);
  check(editor().textContent === "Unsent draft retained" && document.activeElement === editor(), "Failure lost draft/focus");
  fail = false;
  block = true;
  enter();
  await pause(50);
  document.querySelector<HTMLElement>("#outside")!.focus();
  hold!();
  await pause(100);
  check(document.activeElement?.id === "outside", "Completion stole focus from another control");
  reports.push("rapid sends, IME, search dismissal, failure recovery, no focus theft");
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
let channel: ChannelView, messages: ChannelMessageView[], runs: RunView[] = [];
let hasOlder = false, loadingOlder = false;
let loadOlder: (() => Promise<void>) | undefined;
const drawChat = () =>
  render(
    <main style={{ width: 745, height: 850 }}>
      <ChatPane
        key={channel.id}
        channel={channel}
        selectedBot={bots[0]}
        botById={botById}
        agentNameById={emptyMap}
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
  runs = [];
  hasOlder = false;
  loadingOlder = false;
  loadOlder = undefined;
};
async function chatScenario(kind: "bot_dm" | "group") {
  newChat(kind, kind);
  const at = new Date(Date.now() - 3600000).toISOString();
  messages = ["First", "Second", "Third"].map((text, index) => ({ ...message(channel.id, index, text), createdAt: at }));
  messages.push(message(channel.id, 3, "Reply", "user"));
  drawChat();
  await pause(350);
  const ordered = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].map((node) => node.dataset.messageId);
  check(ordered.join() === messages.map((row) => row.id).join(), "Equal timestamps reordered: " + ordered);
  runs = bots.slice(0, kind === "group" ? 3 : 1).map(
    (bot, index) => ({ id: "run-" + index, botId: bot.id, channelId: channel.id, status: kind === "group" ? "queued" : "running", createdAt: new Date().toISOString() }) as RunView
  );
  drawChat();
  await pause(250);
  check(document.querySelector("[data-bot-thinking] svg"), "Thinking does not render our avatar");
  check(!document.querySelector(".bot-thinking-badge"), "Legacy dot pill remains");
  if (kind === "group") check(document.querySelector("[data-bot-thinking]")!.textContent?.endsWith("…"), "Activity ellipsis missing");
  runs = [];
  drawChat();
  await pause(250);
  check(!document.querySelector("[data-bot-thinking]"), "Thinking did not drain on completion");
  reports.push(`${kind}: chronology and concurrent thinking`);
  render(null);
  await pause(50);
}
async function historyScenario() {
  newChat("history", "bot_dm");
  messages = Array.from({ length: 120 }, (_, i) =>
    message(channel.id, i, `Earlier message ${String(i + 1).padStart(3, "0")}: keep this reading position when new replies arrive.`, i % 2 ? "agent" : "user")
  );
  hasOlder = true;
  let anchor: { id: string; top: number } | undefined;
  const samples: { time: number; top: number | null }[] = [];
  const viewport = () => document.querySelector<HTMLElement>(".conversation-scroll")!;
  const topFor = () => (anchor ? (document.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`)?.getBoundingClientRect().top ?? null) : null);
  loadOlder = async () => {
    await pause(80); // Observe the new virtual window after a large scrollbar jump.
    const bounds = viewport().getBoundingClientRect();
    const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((row) => row.getBoundingClientRect().bottom > bounds.top)!;
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
    samples.push({ time: performance.now() - start, top: topFor() });
  }
  check(anchor, "History load was not triggered");
  const settled = samples.filter((sample) => sample.time > 750);
  const drift = Math.max(...settled.map((sample) => (sample.top === null ? 9999 : Math.abs(sample.top - anchor!.top))));
  check(drift <= 2, "Delayed history drift " + drift + "px");
  reports.push(`delayed paging anchor (drift ${drift}px)`);
  render(null);
  await pause(50);
}
async function draftReviewScenario(width: number) {
  const draft = parseExternalDraft({ platform: "email", providerIdentifier: "gmail", from: "me@example.com", to: ["ann@example.com"], subject: "Fwd: Schedule", body: "Please review before Friday.", forwardMessageId: "original", attachments: ["/workspace/notes.txt"] });
  const verification = { identity: "me@example.com", destination: "ann@example.com", forwarding: "“Schedule” from Pat", forwardUrl: "https://mail.example.com/original",
    attachments: [{ assetId: "a".repeat(64), fileName: "notes.txt", mimeType: "text/plain", byteSize: 5, kind: "text" }],
    revision: { baselineMessageId: "older", changedFields: ["subject"], body: [{ text: "Please review ", added: false }, { text: "before Friday", added: true }, { text: ".", added: false }] } };
  let card = { id: `draft-${width}`, channelId: "test", sequence: "1", sender: "agent", senderBotId: "bot-0", sourceRunId: null, content: draft.subject, createdAt: new Date().toISOString(), metadata: { type: "external-draft", draft: { ...draft, verification }, cardState: "pending" } } as ChannelMessageView;
  const calls: string[] = [];
  const draw = () => render(<div style={{ width, padding: 12 }}><ExternalDraftCard key={card.id} message={card} draft={parseExternalDraft((card.metadata as any).draft)} bot={bots[0]} /></div>);
  Object.assign(api, { mutateExternalDraft: async (_id: string, action: string) => {
    calls.push(action);
    card = { ...card, metadata: { ...(card.metadata as object), cardState: action === "cancel" ? "dismissed" : "sent" } };
    draw();
    return { accepted: true, message: card, runId: null };
  } });
  const oldFetch = window.fetch;
  window.fetch = async () => new Response("hello", { headers: { "content-type": "text/plain", "content-length": "5" } });
  try {
    draw();
    for (let i = 0; i < 80 && !document.querySelector('[aria-label="Open notes.txt"]'); i++) await pause(100);
    check(document.querySelector('[aria-label="Open notes.txt"]'), "Draft attachment did not render");
    check(document.querySelector('.draft-field[href="https://mail.example.com/original"]')?.textContent?.includes("Forwarding"), "Forwarding source missing");
    check(document.querySelector('.draft-revision-body mark')?.textContent === "before Friday", "Revision highlight missing");
    check(document.querySelector('[aria-label="Subject"][data-revised]'), "Changed subject not highlighted");
    const send = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Send")!;
    const setField = async (label: string, value: string) => {
      const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await pause(50);
    };
    const highlighted = document.querySelector<HTMLElement>('.draft-revision-body')!;
    highlighted.focus(); highlighted.textContent = draft.body + " Updated.";
    const range = document.createRange(); range.selectNodeContents(highlighted); range.collapse(false);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    highlighted.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: " Updated." }));
    await pause(50);
    const editedBody = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message body"]')!;
    check(editedBody.value === draft.body + " Updated." && document.activeElement === editedBody && editedBody.selectionStart === editedBody.value.length, "Editing highlighted text lost content, focus or caret");
    await setField("To", "invalid"); check(send().disabled, "Invalid To left Send enabled");
    await setField("To", ""); check(send().disabled, "Empty To left Send enabled");
    await setField("To", "ann@example.com");
    await setField("Cc", "invalid"); check(send().disabled, "Invalid Cc left Send enabled");
    await setField("Cc", ""); check(!send().disabled, "Valid recipients left Send disabled");
    await setField("Message body", ""); check(send().disabled, "Empty body left Send enabled");
    await setField("Message body", draft.body); check(!send().disabled, "Valid body left Send disabled");
    document.querySelector<HTMLButtonElement>('[aria-label="Open notes.txt"]')!.click();
    for (let i = 0; i < 30 && !document.querySelector('[role="dialog"]')?.textContent?.includes("hello"); i++) await pause(100);
    check(document.querySelector('[role="dialog"]')?.textContent?.includes("hello"), "Draft attachment preview did not load");
    document.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!.click(); await pause(100);
    await setField("To", "edited@example.com");
    await setField("Subject", "Local subject edit");
    await setField("Message body", "Local body edit that was never submitted.");
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Discard")!.click();
    await pause(150);
    check(calls.join(",") === "cancel", "Discard made an unexpected send");
    check(!document.querySelector("form"), "Discarded card stayed editable");
    document.querySelector<HTMLElement>("details > summary")!.click(); await pause(50);
    check(document.querySelector("details")?.open, "Discarded draft did not reopen");
    check(document.querySelector("details .draft-body")?.textContent === draft.body, "Reopened draft lost its body");
    check(document.querySelector("details")?.textContent?.includes("ann@example.com") && !document.querySelector("details")?.textContent?.includes("edited@example.com"), "Discarded history kept unsubmitted recipient edits");
    check(document.querySelector("details")?.textContent?.includes(draft.subject!) && !document.querySelector("details")?.textContent?.includes("Local subject edit"), "Discarded history kept unsubmitted subject edits");
    check(![...document.querySelectorAll('button')].some(button => button.textContent === "Send"), "Reopening a discarded card restored Send");
    check(document.querySelector('.draft-card')!.getBoundingClientRect().width <= width, "Draft overflows narrow chat");
    render(null); await pause(50); draw(); await pause(100);
    check(!document.querySelector("form") && document.querySelector("details"), "Discarded state was lost after remount");
    // Keep the same mounted component while a different device submits edits.
    card = { ...card, id: card.id + "-remote", metadata: { type: "external-draft", cardState: "pending", draft: { ...draft, verification } } };
    draw(); await pause(100);
    await setField("To", "unsaved@example.com");
    await setField("Message body", "Unsubmitted local text.");
    const remote = { ...draft, from: "other@example.com", to: ["remote@example.com"], cc: ["copied@example.com"], subject: "Sent from another device", body: "Server-confirmed body." };
    card = { ...card, metadata: { type: "external-draft", cardState: "sent", draft: { ...remote, verification } } };
    draw(); await pause(100);
    document.querySelector<HTMLElement>("details > summary")!.click(); await pause(50);
    check(document.querySelector("details .draft-body")?.textContent === remote.body, "Sent history retained stale local body after remote edits");
    for (const value of [remote.from, remote.to[0]!, remote.cc[0]!, remote.subject])
      check(document.querySelector("details")?.textContent?.includes(value), "Sent history lost remote field: " + value);
    check(!document.querySelector("form") && !document.querySelector("details")?.textContent?.includes("unsaved@example.com"), "Sent history retained unsaved edits");
    card = { ...card, id: card.id + "-response", metadata: { type: "external-draft", cardState: "pending", draft: { ...draft, verification } } };
    draw(); await pause(100);
    Object.assign(api, { mutateExternalDraft: async () => {
      calls.push("send");
      return { accepted: false, message: { ...card, metadata: { type: "external-draft", cardState: "sent", draft: { ...remote, verification } } }, runId: null };
    } });
    send().click(); await pause(150);
    document.querySelector<HTMLElement>("details > summary")!.click(); await pause(50);
    check(document.querySelector("details .draft-body")?.textContent === remote.body, "Mutation receipt lost canonical history before its live update arrived");
    reports.push(`email draft at ${width}px: forwarding, revision, attachment preview, validation, discard and remote-send history`);
  } finally { window.fetch = oldFetch; render(null); await pause(50); }
}

// Delivery lifecycle: a send that fails, retries, or is accepted late keeps one bubble
// throughout, with honest wording and no duplicate dispatch. Only the API and ACK clock are fake.
const controller = desktopDurableSendController();
let lastFailure: DurableSendRecord | undefined;
const userRows = () => [...document.querySelectorAll<HTMLElement>('[data-role="user"][data-message-id]')];
type Mode = "retry-failure" | "failed" | "uncertain-late-echo";
async function sendScenario(id: Mode) {
  clockOffset = 0;
  newChat(id, "bot_dm");
  messages = Array.from({ length: 5 }, (_, i) => message(id, i, `Earlier message ${i + 1}`));
  let dispatches = 0;
  let resolveDispatch: (value: { message: ChannelMessageView }) => void = () => {};
  let rejectDispatch: (reason: unknown) => void = () => {};
  let echo: ChannelMessageView;
  let status: MessageDeliveryStatusView["status"] = "not_found";
  Object.assign(api, {
    messageDeliveryStatus: async (_channel: string, clientId: string): Promise<MessageDeliveryStatusView> => ({
      clientId, status, acceptedAtMs: status === "accepted" ? wallNow() : null,
      message: status === "accepted" ? echo : null,
    }),
    sendMessage: async (_channel: string, content: string, _assets: unknown, _reply: unknown, options: { clientId: string }) => {
      dispatches++;
      echo = { id: `server-${id}`, clientId: options.clientId, channelId: id, sequence: "21", sender: "user",
        senderBotId: null, sourceRunId: null, content, metadata: {}, createdAt: new Date(wallNow()).toISOString() };
      return new Promise<{ message: ChannelMessageView }>((resolve, reject) => { resolveDispatch = resolve; rejectDispatch = reject; });
    },
  });
  drawChat();
  await pause(350);
  const composer = editor();
  check(composer, `${id}: composer missing`);
  composer.focus();
  composer.textContent = "Reconcile delivery safely before retrying.";
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  await pause(250);
  enter();
  await pause(650);
  const node = userRows()[0]!;
  check(node && dispatches === 1, `${id}: optimistic send missing or duplicated`);
  check(document.activeElement === composer && !composer.textContent?.trim(), `${id}: composer lost focus or kept the text`);
  check(!node.querySelector("[data-send-progress]"), `${id}: retry bar appeared before two failed attempts`);
  const record = () => controller.getSnapshot().find((r) => r.target.channelId === id);
  const retry = () => node.querySelector<HTMLButtonElement>("[data-failed-send-actions] button")!.click();
  if (id === "retry-failure") {
    for (let failure = 1; failure <= 2; failure++) {
      rejectDispatch(Object.assign(Error("Temporarily unavailable"), { status: 503 }));
      await pause(350);
      check(Boolean(node.querySelector("[data-send-progress]")) === (failure === 2),
        `${id}: retry bar must appear only after the second failed attempt`);
      const deadline = performance.now() + 6500;
      while (dispatches < failure + 1 && performance.now() < deadline) await pause(100);
      check(dispatches === failure + 1, `${id}: transient failure did not retry automatically`);
    }
    rejectDispatch(Object.assign(Error("Still temporarily unavailable"), { status: 503 }));
    const expiryDeadline = performance.now() + 8_000;
    while (record()?.phase !== "failed" && performance.now() < expiryDeadline) await pause(100);
    lastFailure = record();
    check(lastFailure?.phase === "failed", `${id}: terminal failure missing`);
    check(!node.querySelector("[data-send-progress]"), `${id}: bar kept running after failure`);
    check(node.textContent?.includes("Delivery unconfirmed"), `${id}: uncertain delivery was reported as a definite failure`);
    retry();
    await pause(500);
    check(dispatches === 4, `${id}: manual retry did not send exactly once`);
    check(!node.querySelector("[data-send-progress]"), `${id}: manual retry reused the previous failure count`);
  } else {
    if (id === "failed") {
      rejectDispatch(Object.assign(Error("The server rejected this test message."), { status: 422, code: "test_rejected" }));
    } else {
      clockOffset = DURABLE_SEND_ACK_TIMEOUT_MS + 1;
      await controller.expireAcknowledgements();
      clockOffset = 0;
    }
    await pause(400);
    check(record()?.phase === "failed", `${id}: terminal status missing`);
    check(userRows()[0] === node, `${id}: failure recreated bubble`);
    check(node.textContent?.includes(id === "failed" ? "Not delivered" : "Delivery unconfirmed"), `${id}: incorrect failure wording`);
    check(!node.querySelector("[data-failed-send-actions]")?.textContent?.includes("The server rejected"),
      `${id}: full error explanation leaked into the caption`);
    if (id === "uncertain-late-echo") {
      status = "pending";
      retry();
      await pause(350);
      check(dispatches === 1, `${id}: unsafe resend dispatched while status was pending`);
      check(document.querySelector('[role="alert"]')?.textContent?.includes("still unconfirmed"), `${id}: blocked retry explanation missing`);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await pause(100);
      status = "accepted";
      retry();
      await pause(350);
      check(dispatches === 1, `${id}: late acceptance resent a duplicate`);
    } else {
      retry();
      await pause(450);
      check(dispatches === 2, `${id}: retry did not dispatch exactly once`);
      check(userRows().length === 1 && userRows()[0] === node, `${id}: retry recreated or duplicated the bubble`);
    }
  }
  resolveDispatch({ message: echo! });
  await pause(200);
  messages.push(echo!);
  drawChat();
  await pause(400);
  drawChat(); // Repeated authoritative snapshot must remain a single bubble.
  await pause(250);
  check(userRows().length === 1 && userRows()[0] === node, `${id}: echo replaced or duplicated bubble`);
  check(!record(), `${id}: delivery journal not reconciled`);
  check(!document.querySelector("[data-send-progress]"), `${id}: accepted message kept sending dots`);
  reports.push(`send ${id}: one bubble from send to echo (${dispatches} dispatches)`);
  render(null);
  await pause(50);
}

async function threadReplyActions() {
  check(lastFailure, "Missing failed-send fixture");
  const delivery = { ...lastFailure!, payload: { ...lastFailure!.payload, content: "Hi" } };
  let clicks = 0;
  let deletes = 0;
  const noop = async () => {};
  render(<ThreadTray open root={durableSendMessage(delivery)} replies={[]} deliveries={[delivery]} recoveries={[]}
    botById={emptyMap} mentionOptions={[]} transcriptionConfigured={false} onClose={() => {}}
    onCancelSend={async () => null} onDeleteSend={async () => { deletes++; }} onResendSend={async () => { clicks++; }}
    onAcknowledgeRecovery={noop} onSubmit={noop} onStage={async () => { throw Error("No attachments in this fixture"); }} />);
  await pause(500);
  const row = document.querySelector<HTMLElement>(".thread-message-row")!;
  const button = row.querySelector<HTMLButtonElement>("[data-failed-send-actions] button")!;
  const bounds = button.getBoundingClientRect();
  const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  check(hit && button.contains(hit), "A short thread reply clipped its retry control");
  button.click();
  await pause(50);
  check(clicks === 1, "Thread retry was not actionable");
  row.querySelector<HTMLButtonElement>('[aria-label="Message delivery details"]')!.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  await pause(100);
  const menu = document.querySelector('[role="menu"]');
  check(menu?.textContent?.includes("Delete message"), "Message deletion missing from delivery details");
  menu!.querySelector<HTMLElement>('[role="menuitem"]')!.click();
  await pause(100);
  check(deletes === 1, "Delivery details did not delete the message");
  reports.push("thread reply: retry and delete reachable on a short failed reply");
  render(null);
}

try {
  document.documentElement.dataset.theme = "dark";
  await controller.restore();
  await inputScenario();
  for (const kind of ["bot_dm", "group"] as const) await chatScenario(kind);
  await historyScenario();
  // The narrow width is the one that can overflow; every draft-review check runs there.
  await draftReviewScenario(360);
  for (const mode of ["failed", "uncertain-late-echo", "retry-failure"] as const) await sendScenario(mode);
  await threadReplyActions();
  console.log("FIXTURE_RESULT " + JSON.stringify({ reports }));
} catch (error) {
  console.log("FIXTURE_RESULT " + JSON.stringify({ error: String(error), reports }));
}
