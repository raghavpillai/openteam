import type { BotView, ChannelMessageView, ChannelView, ClientSnapshot, MessageDeliveryStatusView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { DURABLE_SEND_ACK_TIMEOUT_MS, durableSendMessage, type DurableSendRecord } from "@openteam/product-core/durable-delivery";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { ThreadTray } from "../../src/renderer/components/openteam/thread-tray";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { desktopDurableSendController } from "../../src/renderer/lib/durable-sends";
import "../../src/renderer/styles.css";

// Production desktop renderer and durable controller; only network responses and
// the ACK clock are controlled. Checks what the user sees for a send that fails,
// retries, or is accepted late: one bubble throughout, honest wording, no duplicates.
window.fetch = async () => { throw Error("Unexpected network in lifecycle verification"); };
const wallNow = Date.now;
let clockOffset = 0;
Date.now = () => wallNow() + clockOffset;
const controller = desktopDurableSendController();
const root = createRoot(document.getElementById("root")!);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const emptyMap = new Map();
const emptyList: [] = [];
const runtime: ClientSnapshot["runtime"] = {
  server: "ready", database: "ready", queue: "ready", computer: "ready", inference: "ready",
};
const mutate = async <T,>(operation: () => Promise<T>) => operation();
let lastFailure: DurableSendRecord | undefined;
const userRows = () => [...document.querySelectorAll<HTMLElement>('[data-role="user"][data-message-id]')];
type Mode = "retry-failure" | "failed" | "uncertain-late-echo";
async function scenario(mode: Mode) {
  clockOffset = 0;
  const id = mode;
  const channel = { id, kind: "bot_dm", name: "Delivery check", members: [{ botId: "bot", ordinal: 0 }],
    unreadCount: 0, createdAt: new Date(wallNow() - 60000).toISOString() } as ChannelView;
  const bot = { id: "bot", name: "Delivery check", conversationId: `conversation-${id}`,
    status: "active", onboardingStatus: "completed", color: "blue", icon: "chip" } as BotView;
  const botById = new Map([[bot.id, bot]]);
  const messages: ChannelMessageView[] = Array.from({length: 5}, (_, i) => ({
    id: `history-${id}-${i}`, channelId: id, sequence: String(i + 1), sender: "agent", senderBotId: bot.id,
    sourceRunId: null, content: `Earlier message ${i + 1}`,
    metadata: {}, createdAt: new Date(wallNow() - (30 - i) * 1000).toISOString(),
  }));
  const render = () => root.render(<StrictMode><TooltipProvider><main style={{height: "100vh", width: "100vw"}}>
    <ChatPane key={id} channel={channel} selectedBot={bot} botById={botById} agentNameById={emptyMap}
      itemsByRun={emptyMap} capabilities={CLIENT_CAPABILITIES} messages={[...messages]} runs={emptyList}
      subagents={emptyList} runtime={runtime} mutate={mutate} focusMessage={null} />
  </main></TooltipProvider></StrictMode>);
  let dispatches = 0;
  let resolveDispatch: (value: {message: ChannelMessageView}) => void = () => {};
  let rejectDispatch: (reason: unknown) => void = () => {};
  let echo: ChannelMessageView;
  let status: MessageDeliveryStatusView["status"] = "not_found";
  Object.assign(api, {
    pluginComposer: async () => ({items: []}),
    messageDeliveryStatus: async (_channel: string, clientId: string): Promise<MessageDeliveryStatusView> => ({
      clientId, status, acceptedAtMs: status === "accepted" ? wallNow() : null,
      message: status === "accepted" ? echo : null,
    }),
    sendMessage: async (_channel: string, content: string, _assets: unknown, _reply: unknown, options: {clientId: string}) => {
      dispatches++;
      echo = { id: `server-${id}`, clientId: options.clientId, channelId: id, sequence: "21", sender: "user",
        senderBotId: null, sourceRunId: null, content, metadata: {}, createdAt: new Date(wallNow()).toISOString() };
      return new Promise<{message: ChannelMessageView}>((resolve, reject) => {resolveDispatch = resolve; rejectDispatch = reject;});
    },
  });
  render();
  await pause(350);
  const editor = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!;
  check(editor, `${id}: composer missing`);
  editor.focus();
  editor.textContent = "Reconcile delivery safely before retrying.";
  editor.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText"}));
  await pause(250);
  editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", code: "Enter", bubbles: true, cancelable: true}));
  await pause(650);
  const node = userRows()[0]!;
  check(node && dispatches === 1, `${id}: optimistic send missing or duplicated`);
  check(document.activeElement === editor && !editor.textContent?.trim(), `${id}: composer lost focus or kept the text`);
  check(!node.querySelector("[data-send-progress]"), `${id}: retry bar appeared before two failed attempts`);
  const record = () => controller.getSnapshot().find(r => r.target.channelId === id);
  const retry = () => node.querySelector<HTMLButtonElement>('[data-failed-send-actions] button')!.click();
  if (mode === "retry-failure") {
    for (let failure = 1; failure <= 2; failure++) {
      rejectDispatch(Object.assign(Error("Temporarily unavailable"), {status: 503}));
      await pause(350);
      check(Boolean(node.querySelector("[data-send-progress]")) === (failure === 2),
        `${id}: retry bar must appear only after the second failed attempt`);
      const deadline = performance.now() + 6500;
      while (dispatches < failure + 1 && performance.now() < deadline) await pause(100);
      check(dispatches === failure + 1, `${id}: transient failure did not retry automatically`);
    }
    rejectDispatch(Object.assign(Error("Still temporarily unavailable"), {status: 503}));
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
    if (mode === "failed") {
      rejectDispatch(Object.assign(Error("The server rejected this test message."), {status: 422, code: "test_rejected"}));
    } else {
      clockOffset = DURABLE_SEND_ACK_TIMEOUT_MS + 1;
      await controller.expireAcknowledgements();
      clockOffset = 0;
    }
    await pause(400);
    check(record()?.phase === "failed", `${id}: terminal status missing`);
    check(userRows()[0] === node, `${id}: failure recreated bubble`);
    check(node.textContent?.includes(mode === "failed" ? "Not delivered" : "Delivery unconfirmed"), `${id}: incorrect failure wording`);
    check(!node.querySelector("[data-failed-send-actions]")?.textContent?.includes("The server rejected"),
      `${id}: full error explanation leaked into the caption`);
    if (mode === "uncertain-late-echo") {
      status = "pending";
      retry();
      await pause(350);
      check(dispatches === 1, `${id}: unsafe resend dispatched while status was pending`);
      check(document.querySelector('[role="alert"]')?.textContent?.includes("still unconfirmed"), `${id}: blocked retry explanation missing`);
      document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
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
  resolveDispatch({message: echo!});
  await pause(200);
  messages.push(echo!);
  render();
  await pause(400);
  render(); // Repeated authoritative snapshot must remain a single bubble.
  await pause(250);
  check(userRows().length === 1 && userRows()[0] === node, `${id}: echo replaced or duplicated bubble`);
  check(!record(), `${id}: delivery journal not reconciled`);
  check(!document.querySelector("[data-send-progress]"), `${id}: accepted message kept sending dots`);
  console.log(`LIFECYCLE_STEP ${id}:confirmed`);
  return `${id}: one bubble from send to echo, ${dispatches} dispatch(es)`;
}

async function threadReplyActions() {
  check(lastFailure, "Missing failed-send fixture");
  const delivery = {...lastFailure!, payload: {...lastFailure!.payload, content: "Hi"}};
  const message = durableSendMessage(delivery);
  let clicks = 0;
  let deletes = 0;
  const noop = async () => {};
  root.render(<TooltipProvider>
    <ThreadTray open root={message} replies={[]} deliveries={[delivery]} recoveries={[]}
      botById={emptyMap} mentionOptions={[]} transcriptionConfigured={false} onClose={() => {}}
      onCancelSend={async () => null} onDeleteSend={async () => {deletes++;}} onResendSend={async () => {clicks++;}}
      onAcknowledgeRecovery={noop} onSubmit={noop} onStage={async () => {throw Error("No attachments in this fixture");}} />
  </TooltipProvider>);
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
    new PointerEvent("pointerdown", {bubbles: true, button: 0, pointerType: "mouse"}));
  await pause(100);
  const menu = document.querySelector('[role="menu"]');
  check(menu?.textContent?.includes("Delete message"), "Message deletion missing from delivery details");
  menu!.querySelector<HTMLElement>('[role="menuitem"]')!.click();
  await pause(100);
  check(deletes === 1, "Delivery details did not delete the message");
  return "thread reply: retry and delete reachable on a short failed reply";
}

try {
  await controller.restore();
  document.documentElement.dataset.theme = "dark";
  const reports: string[] = [];
  for (const mode of ["failed", "uncertain-late-echo", "retry-failure"] as Mode[]) reports.push(await scenario(mode));
  reports.push(await threadReplyActions());
  console.log("LIFECYCLE_RESULT " + JSON.stringify({reports}));
} catch(error) {
  console.log("LIFECYCLE_RESULT " + JSON.stringify({error: String(error)}));
}
