import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { BotView, ChannelMessageView, ChannelView, RunView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { SearchDialog } from "../../src/renderer/components/openteam/search-dialog";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { ExternalDraftCard } from "../../src/renderer/components/openteam/external-draft-card";
import { parseExternalDraft } from "@openteam/contracts/external-draft";
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
let hasOlder = false,
  loadingOlder = false;
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
async function chatScenario(theme: string, kind: "bot_dm" | "group") {
  newChat(theme + "-" + kind, kind);
  const at = new Date(Date.now() - 3600000).toISOString();
  messages = ["First", "Second", "Third"].map((text, index) => ({
    ...message(channel.id, index, text),
    createdAt: at,
  }));
  messages.push(message(channel.id, 3, "Reply", "user"));
  drawChat();
  await pause(350);
  const ordered = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].map(
    (node) => node.dataset.messageId
  );
  check(
    ordered.join() === messages.map((row) => row.id).join(),
    "Equal timestamps reordered: " + ordered
  );
  runs = bots.slice(0, kind === "group" ? 3 : 1).map(
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
    scenario: "chronology and concurrent thinking",
  });
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
  reports.push({ theme, scenario: "delayed paging anchor", drift });
  check(drift <= 2, "Delayed history drift " + drift + "px");
  render(null);
  await pause(50);
}
async function draftReviewScenario(theme: string, width: number) {
  const draft = parseExternalDraft({ platform: "email", providerIdentifier: "gmail", from: "me@example.com", to: ["ann@example.com"], subject: "Fwd: Schedule", body: "Please review before Friday.", forwardMessageId: "original", attachments: ["/workspace/notes.txt"] });
  const verification = { identity: "me@example.com", destination: "ann@example.com", forwarding: "“Schedule” from Pat", forwardUrl: "https://mail.example.com/original",
    attachments: [{ assetId: "a".repeat(64), fileName: "notes.txt", mimeType: "text/plain", byteSize: 5, kind: "text" }],
    revision: { baselineMessageId: "older", changedFields: ["subject"], body: [{ text: "Please review ", added: false }, { text: "before Friday", added: true }, { text: ".", added: false }] } };
  let card = { id: `draft-${theme}-${width}`, channelId: "test", sequence: "1", sender: "agent", senderBotId: "bot-0", sourceRunId: null, content: draft.subject, createdAt: new Date().toISOString(), metadata: { type: "external-draft", draft: { ...draft, verification }, cardState: "pending" } } as ChannelMessageView;
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
    // A remote discard is authoritative even when both in-flight HTTP responses fail.
    card = { ...card, id: card.id + "-late-failure", metadata: { type: "external-draft", cardState: "pending", draft: { ...draft, verification } } };
    draw(); await pause(100);
    let rejectSend!: (error: Error) => void;
    const sending = new Promise<never>((_resolve, reject) => { rejectSend = reject; });
    Object.assign(api, { mutateExternalDraft: async (_id: string, action: string) => {
      if (action === "send") return sending;
      throw new Error("Synthetic refresh offline");
    } });
    send().click(); await pause(50);
    card = { ...card, metadata: { ...(card.metadata as object), cardState: "dismissed" } };
    draw(); await pause(100);
    rejectSend(new Error("Synthetic send response lost")); await pause(150);
    check(!document.querySelector("form") && !!document.querySelector("details"), "Late send failure reopened a remotely discarded card");
    check(!document.querySelector('[role="alert"]'), "Late send failure left an error on a confirmed discard");
    check(![...document.querySelectorAll('button')].some(button => ["Send", "Check delivery"].includes(button.textContent ?? "")), "Late send failure restored discarded-card controls");
    reports.push({ theme, width, scenario: "draft forwarding, revision, attachment preview, validation and discard history", calls });
  } finally { window.fetch = oldFetch; render(null); await pause(50); }
}

try {
  const theme = "dark";
  document.documentElement.dataset.theme = theme;
  await inputScenario(theme);
  for (const kind of ["bot_dm", "group"] as const) await chatScenario(theme, kind);
  await historyScenario(theme);
  for (const width of [745, 360]) await draftReviewScenario(theme, width);
  console.log("DESKTOP_PARITY_RESULT " + JSON.stringify({ reports }));
} catch (error) {
  console.log("DESKTOP_PARITY_RESULT " + JSON.stringify({ error: String(error), reports }));
}
