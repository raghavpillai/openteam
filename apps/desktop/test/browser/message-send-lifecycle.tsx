import type { BotView, ChannelMessageView, ChannelView, ClientSnapshot, MessageDeliveryStatusView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { DURABLE_SEND_ACK_TIMEOUT_MS } from "@openteam/product-core/durable-delivery";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/renderer/client/openteam-api";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { desktopDurableSendController } from "../../src/renderer/lib/durable-sends";
import "../../src/renderer/styles.css";

// Production desktop renderer and durable controller; only network responses and
// the ACK clock are controlled. The recording is the running Electron renderer.
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
const animationStarts: Element[] = [];
let entrance: {duration: number | string; easing: string; transform?: string; fadeDuration?: number | string} | undefined;
document.addEventListener("animationstart", event => {
  if ((event as AnimationEvent).animationName === "message-row-enter-outgoing") {
    const target = event.target as Element;
    animationStarts.push(target);
    const animations = target.getAnimations() as CSSAnimation[];
    const rise = animations.find(animation => animation.animationName === "message-row-enter-outgoing")?.effect;
    const fade = animations.find(animation => animation.animationName === "message-row-fade")?.effect;
    entrance = rise ? {duration: rise.getTiming().duration, easing: rise.getKeyframes()[0]?.easing ?? rise.getTiming().easing,
      transform: rise.getKeyframes()[0]?.transform as string, fadeDuration: fade?.getTiming().duration} : undefined;
  }
});
const userRows = () => [...document.querySelectorAll<HTMLElement>('[data-role="user"][data-message-id]')];
const geometry = (node: HTMLElement) => {
  const bubble = node.querySelector<HTMLElement>(".message-bubble")!;
  const rect = bubble.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height,
    rowHeight: node.getBoundingClientRect().height, opacity: getComputedStyle(bubble).opacity,
    background: getComputedStyle(bubble).backgroundColor };
};

async function scenario(theme: string, mode: "delayed" | "failed" | "uncertain-safe-retry" | "uncertain-late-echo") {
  document.documentElement.dataset.theme = theme;
  clockOffset = 0;
  const id = `${theme}-${mode}`;
  const channel = { id, kind: "bot_dm", name: "Desktop motion check", members: [{ botId: "motion-bot", ordinal: 0 }],
    unreadCount: 0, createdAt: new Date(wallNow() - 60000).toISOString() } as ChannelView;
  const bot = { id: "motion-bot", name: "Desktop motion check", conversationId: `conversation-${id}`,
    status: "active", onboardingStatus: "completed", color: "blue", icon: "chip" } as BotView;
  const botById = new Map([[bot.id, bot]]);
  const messages: ChannelMessageView[] = Array.from({length: 20}, (_, i) => ({
    id: `history-${id}-${i}`, channelId: id, sequence: String(i + 1), sender: "agent", senderBotId: bot.id,
    sourceRunId: null, content: i === 19 ? "Ready when you are." : `Earlier desktop message ${i + 1}`,
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
  animationStarts.length = 0;
  entrance = undefined;
  const editor = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!;
  check(editor, `${id}: composer missing`);
  editor.focus();
  editor.textContent = mode === "delayed" ? "A smooth send, even with a delayed acknowledgement." :
    mode === "failed" ? "Keep this bubble still when delivery fails." : "Reconcile delivery safely before retrying.";
  editor.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText"}));
  await pause(250);
  const motionFrames: {time: number; previousTop: number; scroll: number}[] = [];
  const motionStartedAt = performance.now();
  let samplingMotion = true;
  const sampleMotion = () => {
    const previous = document.querySelector<HTMLElement>(`[data-message-id="history-${id}-19"]`);
    if(previous) motionFrames.push({time: performance.now() - motionStartedAt,
      previousTop: previous.getBoundingClientRect().top,
      scroll: document.querySelector(".conversation-scroll")?.scrollTop ?? 0});
    if(samplingMotion) requestAnimationFrame(sampleMotion);
  };
  sampleMotion();
  editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", code: "Enter", bubbles: true, cancelable: true}));
  await pause(650);
  samplingMotion = false;
  const node = userRows()[0]!;
  check(node && dispatches === 1, `${id}: optimistic send missing or duplicated`);
  check(document.activeElement === editor, `${id}: composer focus lost`);
  check(!editor.textContent?.trim(), `${id}: composer did not clear`);
  check(!document.body.textContent?.includes("Checking delivery"), `${id}: active checking label visible`);
  const before = geometry(node);
  check(entrance?.duration === 240 && entrance.transform === "translateY(12px)" && entrance.fadeDuration === 200,
    `${id}: outgoing entrance differs from measured desktop rise / requested fade`);
  const sharedTravel = Math.abs(motionFrames.at(-1)!.previousTop - motionFrames[0]!.previousTop);
  const maxMotionStep = Math.max(0, ...motionFrames.slice(1).map((frame, i) => Math.abs(frame.previousTop - motionFrames[i]!.previousTop)));
  check(sharedTravel > 10 && maxMotionStep < sharedTravel * .45, `${id}: transcript snapped instead of gliding`);
  check(before.opacity === "1", `${id}: optimistic bubble dimmed`);
  console.log(`LIFECYCLE_STEP ${id}:pending`);
  const frames: ReturnType<typeof geometry>[] = [];
  let sampling = true;
  const sample = () => { const row = userRows()[0]; if(row) frames.push(geometry(row)); if(sampling) requestAnimationFrame(sample); };
  sample();
  if (mode === "delayed") {
    await pause(1900);
    check(!document.querySelector("[data-send-progress], [data-queued-send-notice], [data-sent-while-offline]"), `${id}: routine delivery bookkeeping visible`);
    check(userRows().length === 1 && userRows()[0] === node, `${id}: delayed ACK duplicated/replaced bubble`);
    check(!document.querySelector('[data-failed-send-actions]'), `${id}: active send falsely failed`);
  } else {
    if(mode === "failed") {
      rejectDispatch(Object.assign(Error("The server rejected this test message."), {status: 422, code: "test_rejected"}));
    } else {
      clockOffset = DURABLE_SEND_ACK_TIMEOUT_MS + 1;
      await controller.expireAcknowledgements();
      clockOffset = 0;
    }
    await pause(400);
    check(controller.getSnapshot().find(r => r.target.channelId === id)?.phase === "failed", `${id}: terminal status missing`);
    check(userRows()[0] === node, `${id}: failure recreated bubble`);
    check(document.body.textContent?.includes(mode === "failed" ? "Failed to send" : "Delivery unconfirmed"), `${id}: incorrect failure wording`);
    console.log(`LIFECYCLE_STEP ${id}:terminal`);
    await pause(700);
    if(mode === "uncertain-late-echo") {
      status = "pending";
      document.querySelector<HTMLButtonElement>('[data-failed-send-actions] button')!.click();
      await pause(350);
      check(dispatches === 1, `${id}: unsafe resend dispatched while status was pending`);
      check(document.querySelector('[role="alert"]')?.textContent?.includes("still unconfirmed"), `${id}: blocked retry explanation missing`);
      status = "accepted";
      document.querySelector<HTMLButtonElement>('[data-failed-send-actions] button')!.click();
      await pause(350);
      check(dispatches === 1, `${id}: late acceptance resent a duplicate`);
      console.log(`LIFECYCLE_STEP ${id}:late-acceptance`);
    } else {
      document.querySelector<HTMLButtonElement>('[data-failed-send-actions] button')!.click();
      await pause(450);
      check(dispatches === 2, `${id}: safe retry did not dispatch exactly once`);
      check(userRows()[0] === node, `${id}: nonce rotation recreated bubble`);
      check(userRows().length === 1, `${id}: retry duplicated bubble`);
      console.log(`LIFECYCLE_STEP ${id}:retry`);
      await pause(700);
    }
  }
  resolveDispatch({message: echo!});
  await pause(200);
  messages.push(echo!);
  render();
  await pause(400);
  render(); // Repeated authoritative snapshot must remain a single bubble.
  await pause(250);
  sampling = false;
  check(userRows().length === 1 && userRows()[0] === node, `${id}: echo replaced or duplicated bubble`);
  check(controller.getSnapshot().filter(r => r.target.channelId === id).length === 0, `${id}: delivery journal not reconciled`);
  check(animationStarts.length === 1, `${id}: entrance replayed ${animationStarts.length} times`);
  const maxGeometryDelta = Math.max(0, ...frames.flatMap(frame =>
    (["top", "left", "width", "height", "rowHeight"] as const).map(key => Math.abs(frame[key] - before[key]))));
  check(maxGeometryDelta <= 1, `${id}: status moved bubble by ${maxGeometryDelta}px`);
  check(frames.every(frame => frame.opacity === "1" && frame.background === before.background), `${id}: status changed bubble appearance`);
  console.log(`LIFECYCLE_STEP ${id}:confirmed`);
  await pause(400);
  return {id, dispatches, sameNode: true, starts: animationStarts.length, maxGeometryDelta,
    entrance, sharedTravel, maxMotionStep, motionFrames,
    samples: frames.length, composerFocusPreserved: true, noDuplicates: true, before, after: geometry(node)};
}

try {
  await controller.restore();
  const reports = [];
  for(const theme of ["dark", "light"])
    for(const mode of ["delayed", "failed", "uncertain-safe-retry", "uncertain-late-echo"] as const)
      reports.push(await scenario(theme, mode));
  console.log("LIFECYCLE_RESULT " + JSON.stringify({reports}));
} catch(error) {
  console.log("LIFECYCLE_RESULT " + JSON.stringify({error: String(error)}));
}
