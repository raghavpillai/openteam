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
// the ACK clock are controlled. The recording is the running Electron renderer.
window.fetch = async () => { throw Error("Unexpected network in lifecycle verification"); };
const wallNow = Date.now;
let clockOffset = 0;
Date.now = () => wallNow() + clockOffset;
const controller = desktopDurableSendController();
const root = createRoot(document.getElementById("root")!);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const emptyMap = new Map();
const emptyList: [] = [];
const runtime: ClientSnapshot["runtime"] = {
  server: "ready", database: "ready", queue: "ready", computer: "ready", inference: "ready",
};
const mutate = async <T,>(operation: () => Promise<T>) => operation();
const animationStarts: Element[] = [];
let lastFailure: DurableSendRecord | undefined;
let entrance: {duration: number | string; easing: string; transform?: string; fadeDuration?: number | string} | undefined;
document.addEventListener("animationstart", event => {
  if (["message-row-enter-outgoing", "message-row-enter-reduced"].includes((event as AnimationEvent).animationName)
    && (event.target as Element).closest('[data-role="user"]')) {
    const target = event.target as Element;
    animationStarts.push(target);
    const animations = target.getAnimations() as CSSAnimation[];
    const rise = animations.find(animation => animation.animationName ===
      (reducedMotion ? "message-row-enter-reduced" : "message-row-enter-outgoing"))?.effect;
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

async function scenario(theme: string, mode: "delayed" | "transient-retry" | "retry-failure" | "failed" | "uncertain-safe-retry" | "uncertain-late-echo") {
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
  editor.textContent = mode === "delayed" ? "A smooth send, even with a delayed acknowledgement.\nKeep the draft’s original height when sending." :
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
  check(reducedMotion ? entrance?.duration === 120 && !entrance.transform :
    entrance?.duration === 240 && entrance.fadeDuration === 200,
    `${id}: ordinary message entrance changed`);
  check(before.rowHeight === before.height, `${id}: a normal send reserved retry space`);
  check(!node.querySelector("[data-send-progress]"), `${id}: retry bar appeared before two failed attempts`);
  const sharedTravel = Math.abs(motionFrames.at(-1)!.previousTop - motionFrames[0]!.previousTop);
  const maxMotionStep = Math.max(0, ...motionFrames.slice(1).map((frame, i) => Math.abs(frame.previousTop - motionFrames[i]!.previousTop)));
  if (!reducedMotion)
    check(sharedTravel > 10 && maxMotionStep < sharedTravel * .45, `${id}: transcript snapped instead of gliding (travel=${sharedTravel}, step=${maxMotionStep}, frames=${JSON.stringify(motionFrames)})`);
  check(!document.querySelector("[data-send-flight]"), `${id}: composer morph must stay removed`);
  check(before.opacity === "1", `${id}: optimistic bubble dimmed`);
  console.log(`LIFECYCLE_STEP ${id}:pending`);
  const frames: ReturnType<typeof geometry>[] = [];
  let sampling = true;
  const sample = () => { const row = userRows()[0]; if(row) frames.push(geometry(row)); if(sampling) requestAnimationFrame(sample); };
  sample();
  if (mode === "transient-retry" || mode === "retry-failure") {
    for (let failure = 1; failure <= 2; failure++) {
      rejectDispatch(Object.assign(Error("Temporarily unavailable"), {status: 503}));
      await pause(350);
      check(Boolean(node.querySelector("[data-send-progress]")) === (failure === 2),
        `${id}: retry bar must appear only after the second failed attempt`);
      console.log(`LIFECYCLE_STEP ${id}:failed-attempt-${failure}`);
      const deadline = performance.now() + 6500;
      while (dispatches < failure + 1 && performance.now() < deadline) await pause(100);
      check(dispatches === failure + 1, `${id}: transient failure did not retry automatically`);
    }
    const progress = node.querySelector<HTMLElement>("[data-send-progress]");
    check(progress, `${id}: retry bar disappeared during retry`);
    check(progress!.getBoundingClientRect().top - node.querySelector(".message-bubble")!.getBoundingClientRect().bottom <= 5,
      `${id}: retry bar sits too far below the bubble`);
    check(progress!.getBoundingClientRect().width === 24 && progress!.getBoundingClientRect().height === 2,
      `${id}: retry bar must use the smaller 24-by-2 size`);
    check(reducedMotion ? progress!.firstElementChild!.getAnimations().length === 0 :
      progress!.firstElementChild!.getAnimations().some(animation => animation.effect?.getTiming().iterations === Infinity),
      `${id}: retry bar did not respect motion preferences`);
    check(geometry(node).rowHeight <= before.height + 10, `${id}: retry bar allocated excess padding`);
    console.log(`LIFECYCLE_STEP ${id}:retry-bar`);
    await pause(400);
    if (mode === "retry-failure") {
      rejectDispatch(Object.assign(Error("Still temporarily unavailable"), {status: 503}));
      await pause(350);
      const expiryDeadline = performance.now() + 8_000;
      while (controller.getSnapshot().find(record => record.target.channelId === id)?.phase !== "failed"
        && performance.now() < expiryDeadline) await pause(100);
      await pause(500);
      lastFailure = controller.getSnapshot().find(r => r.target.channelId === id);
      check(lastFailure?.phase === "failed", `${id}: terminal failure missing`);
      check(!node.querySelector("[data-send-progress]"), `${id}: bar kept running after failure`);
      check(node.textContent?.includes("Delivery unconfirmed"), `${id}: uncertain delivery was reported as a definite failure`);
      const failureText = node.querySelector<HTMLElement>('[data-failed-send-actions] [role="status"]')!;
      check(failureText.getBoundingClientRect().top - node.querySelector(".message-bubble")!.getBoundingClientRect().bottom <= 5,
        `${id}: failure caption sits too far below the bubble`);
      console.log(`LIFECYCLE_STEP ${id}:terminal`);
      await pause(1800);
      node.querySelector<HTMLButtonElement>('[data-failed-send-actions] button')!.click();
      await pause(500);
      check(dispatches === 4, `${id}: manual retry did not send exactly once`);
      check(!node.querySelector("[data-send-progress]"), `${id}: manual retry reused the previous failure count`);
      console.log(`LIFECYCLE_STEP ${id}:manual-retry`);
      await pause(1500);
    }
  } else if (mode === "delayed") {
    await pause(1900);
    check(!node.querySelector("[data-send-progress]"), `${id}: slow first request incorrectly showed retry bar`);
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
    lastFailure = controller.getSnapshot().find(r => r.target.channelId === id);
    check(userRows()[0] === node, `${id}: failure recreated bubble`);
    check(document.body.textContent?.includes(mode === "failed" ? "Not delivered" : "Delivery unconfirmed"), `${id}: incorrect failure wording`);
    check(geometry(node).rowHeight >= before.rowHeight + 8, `${id}: visible failure did not expand its row`);
    check(!node.querySelector("[data-send-progress]"), `${id}: progress continued after failure`);
    check(!node.querySelector("[data-failed-send-actions]")?.textContent?.includes("The server rejected"),
      `${id}: full error explanation leaked into the caption`);
    console.log(`LIFECYCLE_STEP ${id}:terminal`);
    await pause(700);
    if(mode === "uncertain-late-echo") {
      status = "pending";
      document.querySelector<HTMLButtonElement>('[data-failed-send-actions] button')!.click();
      await pause(350);
      check(dispatches === 1, `${id}: unsafe resend dispatched while status was pending`);
      check(document.querySelector('[role="alert"]')?.textContent?.includes("still unconfirmed"), `${id}: blocked retry explanation missing`);
      document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
      await pause(100);
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
    (["left", "width", "height"] as const).map(key => Math.abs(frame[key] - before[key]))));
  check(maxGeometryDelta <= 1, `${id}: status changed the bubble's size or horizontal position`);
  const after = geometry(node);
  check(Math.abs(after.rowHeight - after.height) <= 1, `${id}: cleared delivery retained padding`);
  check(Math.abs(after.top - before.top - (before.rowHeight - before.height)) <= 2, `${id}: transcript did not return after the caption collapsed`);
  check(!document.querySelector("[data-send-progress]"), `${id}: accepted message kept sending dots`);
  const heights = frames.map(frame => frame.rowHeight);
  const captionTravel = Math.max(...heights) - Math.min(...heights);
  const maxResizeStep = Math.max(0, ...heights.slice(1).map((height, i) => Math.abs(height - heights[i]!)));
  if(mode !== "delayed" && !reducedMotion) {
    check(new Set(heights.map(height => Math.round(height))).size >= 4,
      `${id}: delivery padding snapped instead of animating`);
    check(maxResizeStep < captionTravel * .8, `${id}: delivery padding changed in one frame`);
  }
  check(frames.every(frame => frame.opacity === "1" && frame.background === before.background), `${id}: status changed bubble appearance`);
  console.log(`LIFECYCLE_STEP ${id}:confirmed`);
  messages.push({...echo!, id: `history-next-${id}`, clientId: null, sequence: "22", content: "Another delivered message"});
  render();
  await pause(500);
  const next = document.querySelector<HTMLElement>(`[data-message-id="history-next-${id}"] .message-bubble`)!;
  const gap = next.getBoundingClientRect().top - node.querySelector(".message-bubble")!.getBoundingClientRect().bottom;
  check(Math.abs(gap - 4) <= 1, `${id}: delivered bubbles have a ${gap}px gap; rows=${JSON.stringify(userRows().map(row => ({id: row.dataset.messageId, top: row.getBoundingClientRect().top, class: row.className, text: row.textContent})))}`);
  return {id, dispatches, sameNode: true, starts: animationStarts.length, maxGeometryDelta,
    entrance, sharedTravel, maxMotionStep, motionFrames,
    captionTravel, maxResizeStep, deliveredGap: gap,
    samples: frames.length, composerFocusPreserved: true, noDuplicates: true, before, after};
}

async function shortThreadReply() {
  check(lastFailure, "Missing failed-send fixture");
  const delivery = {...lastFailure!, payload: {...lastFailure!.payload, content: "Hi"}};
  const message = durableSendMessage(delivery);
  let clicks = 0;
  let deletes = 0;
  const noop = async () => {};
  const render = (deliveries: DurableSendRecord[]) => root.render(<TooltipProvider>
    <ThreadTray open root={message} replies={[]} deliveries={deliveries} recoveries={[]}
      botById={emptyMap} mentionOptions={[]} transcriptionConfigured={false} onClose={() => {}}
      onCancelSend={async () => null} onDeleteSend={async () => {deletes++;}} onResendSend={async () => {clicks++;}}
      onAcknowledgeRecovery={noop} onSubmit={noop} onStage={async () => {throw Error("No attachments in this fixture");}} />
  </TooltipProvider>);
  render([delivery]);
  await pause(500);
  const row = document.querySelector<HTMLElement>(".thread-message-row")!;
  const bubble = row.querySelector<HTMLElement>(".message-bubble")!;
  check(bubble.getBoundingClientRect().width < 80, "Thread caption stretched a short bubble");
  const before = geometry(row);
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
  render([]);
  await pause(400);
  const after = geometry(row);
  check(Math.abs(after.rowHeight - after.height) <= 1, "Thread retained cleared delivery padding");
  check(Math.abs(after.width - before.width) <= 1, "Thread acknowledgement changed the bubble width");
  return {id: "short-thread-reply", captionTravel: before.rowHeight - after.rowHeight, retryActionable: true};
}

try {
  await controller.restore();
  const reports = [];
  const recording = new URLSearchParams(location.search).has("retry-bar-recording");
  if (recording) {
    reports.push(await scenario("dark", "retry-failure"));
    reports.push(await scenario("dark", "transient-retry"));
  } else {
    for(const theme of reducedMotion ? ["dark"] : ["dark", "light"])
      for(const mode of (reducedMotion ? ["delayed", "failed"] :
        ["delayed", "failed", "uncertain-safe-retry", "uncertain-late-echo"]) as
        ("delayed" | "transient-retry" | "retry-failure" | "failed" | "uncertain-safe-retry" | "uncertain-late-echo")[])
        reports.push(await scenario(theme, mode));
    reports.push(await scenario("dark", "transient-retry"));
    reports.push(await shortThreadReply());
  }
  console.log("LIFECYCLE_RESULT " + JSON.stringify({reports}));
} catch(error) {
  console.log("LIFECYCLE_RESULT " + JSON.stringify({error: String(error)}));
}
