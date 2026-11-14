/** The email and Messages draft cards against a stand-in server and store, for
    scripts/test-draft-send-off.ts. Query: card=imessage, latency, cancel, fail,
    senderror, pushlag, lazy, scaled, list. */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ChannelMessageView } from "@openteam/contracts";
import { parseExternalDraft } from "@openteam/contracts/external-draft";
import { ExternalDraftCard } from "../../src/renderer/components/openteam/external-draft-card";
import { IMessageSendCard } from "../../src/renderer/components/openteam/imessage-send-card";
import { api } from "../../src/renderer/client/openteam-api";
import "../../src/renderer/styles.css";

const params = new URLSearchParams(location.search);
// `lazy` leaves the flight module to the card, as in the app, so a test can fail its load.
if (!params.has("lazy")) await import("../../src/renderer/components/openteam/external-draft-send-flight");
document.documentElement.dataset.theme = "dark";
const imessage = params.get("card") === "imessage";
const draft = {
  platform: "email", providerIdentifier: "gmail", from: "sam@example.com", to: ["austin@example.com"],
  cc: ["avi@example.com"], subject: "RE: Colocation inquiry", body: "Hi Austin,\n\nMonday at noon works for me.\n\nThanks,\nSam",
  replyToMessageId: "original",
  verification: { identity: "sam@example.com", destination: "austin@example.com", thread: "“RE: Colocation inquiry”" },
};
const base = { channelId: "demo", sequence: "1", sender: "agent", senderBotId: "bot", sourceRunId: null, createdAt: new Date().toISOString() };
// `server` is the truth; `stored` is what the store has pushed to the chat, which can lag it.
let stored = (imessage
  ? { ...base, id: "imessage", content: "Send this message?", metadata: { type: "imessage-send", cardState: "pending", imessage: { text: "Running ten minutes late!", to: "+1 (415) 555-0134", recipientName: "Maya Chen", machineLabel: "Sam's Mac", allowable: true } } }
  : { ...base, id: "draft", content: draft.subject, metadata: { type: "external-draft", draft, cardState: "pending" } }) as unknown as ChannelMessageView;
let server = stored;
const control = {
  trace: [] as string[], times: {} as Record<string, number>, requests: 0, shown: true, failRefresh: false,
  fail: params.has("fail"), senderror: params.has("senderror"),
  latency: Number(params.get("latency") ?? 900), cancel: Number(params.get("cancel") ?? 300), pushlag: Number(params.get("pushlag") ?? 0),
};
/** The chat's list in miniature: rows are placed from the top in a box of a set
    height, the view is held at the bottom, and a row's new height is only applied
    a frame later: in a task after that frame, or (`list=frame`) inside it. */
function LaggingList({ children }: { children: ReactNode }) {
  const view = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const apply = () => {
      content.current!.style.height = `${600 + row.current!.offsetHeight + 16}px`;
      view.current!.scrollTop = view.current!.scrollHeight;
    };
    apply();
    let frame = 0;
    let task = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(params.get("list") === "frame" ? apply : () => (task = window.setTimeout(apply)));
    });
    observer.observe(row.current!);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(task);
    };
  }, []);
  return (
    <div ref={view} style={{ height: 500, overflowY: "auto" }}>
      <div ref={content} style={{ position: "relative" }}>
        <div data-virtual-timeline-index="0" ref={row} style={{ position: "absolute", top: 600, left: 0, right: 0 }}>{children}</div>
      </div>
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
const draw = () => {
  const card = !control.shown ? null : imessage ? (
    <IMessageSendCard message={stored} />
  ) : (
    <ExternalDraftCard bot={{ draftingDisabled: false, draftAllowedRecipients: [] }} draft={parseExternalDraft((stored.metadata as { draft: unknown }).draft)} message={stored} />
  );
  root.render(
    <main style={{ minHeight: "100vh", background: "var(--background)", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 36, boxSizing: "border-box" }}>
      {/* `scaled`: a row caught mid-entrance. */}
      <div style={{ width: 560, maxWidth: "100%", transform: params.has("scaled") ? "translateY(8px) scale(0.94)" : undefined }}>
        {params.has("list") && card ? <LaggingList>{card}</LaggingList> : card}
      </div>
    </main>
  );
};
const withState = (message: ChannelMessageView, patch: Record<string, unknown>) =>
  ({ ...message, metadata: { ...(message.metadata as object), ...patch } }) as ChannelMessageView;
const push = (message: ChannelMessageView, after: number) =>
  setTimeout(() => {
    stored = message;
    draw();
  }, after);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mutate = async (_id: string, action: string) => {
  if (action === "refresh") {
    await wait(40);
    if (control.failRefresh) throw new Error("offline");
    return { message: server };
  }
  control.requests++;
  if (action === "cancel") {
    await wait(control.cancel);
    if (control.fail) throw new Error("Couldn't reach the server");
    server = withState(server, { cardState: "dismissed" });
    push(server, control.pushlag);
    return { message: server };
  }
  // The server claims the send at once and says so to every device.
  server = withState(server, { cardState: "sending" });
  push(server, 60);
  const claimed = performance.now();
  // Pushes arrive in order: the outcome never overtakes the claim.
  const after = () => Math.max(control.pushlag, 70 - (performance.now() - claimed));
  await wait(control.latency);
  if (control.fail) {
    server = withState(server, { cardState: "pending" });
    push(server, after());
    throw new Error("Couldn't reach the mail server");
  }
  server = control.senderror
    ? withState(server, { cardState: "pending", sendError: "The recipient's server refused the message" })
    : withState(server, { cardState: "sent" });
  push(server, after());
  return { message: server };
};
Object.assign(api, { mutateExternalDraft: mutate, mutateIMessageSend: mutate, setExternalDraftApproval: async () => ({}) });
draw();
new MutationObserver(() => {
  const fx = document.querySelector<HTMLElement>(".draft-card")?.dataset.fx ?? "";
  if (!fx || control.trace.at(-1) === fx) return;
  control.trace.push(fx);
  control.times[fx] = performance.now();
}).observe(document.body, { attributes: true, attributeFilter: ["data-fx"], subtree: true, childList: true });
(window as any).draftSendOffQA = {
  control,
  /** Switch to another chat (the card unmounts) and back. */
  leave() { control.shown = false; draw(); },
  back() { control.shown = true; draw(); },
  /** A push caused by another device. */
  remote(state: string) { server = withState(server, { cardState: state }); push(server, 0); },
  /** The card's bottom edge on screen, each frame for `ms`, as painted: read by the
      last callback of the frame (re-armed from a task, after everyone else's). */
  bottoms(ms: number) {
    return new Promise<number[]>((resolve) => {
      const seen: number[] = [];
      const end = performance.now() + ms;
      const channel = new MessageChannel();
      const tick = () => {
        const card = document.querySelector(".draft-card");
        if (card) seen.push(card.getBoundingClientRect().bottom);
        if (performance.now() < end) channel.port2.postMessage(0);
        else resolve(seen);
      };
      channel.port1.onmessage = () => requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    });
  },
  /** What the user can see and do right now. */
  look() {
    const card = document.querySelector<HTMLElement>(".draft-card");
    if (!card) return { gone: true };
    const seen = (item: Element | null) => Boolean(item) && getComputedStyle(item as Element).opacity !== "0" && getComputedStyle(item as Element).visibility !== "hidden";
    const status = card.querySelector(".draft-header:not(.draft-fx-header) .draft-status");
    return {
      fx: card.dataset.fx ?? "",
      status: status?.textContent?.trim() ?? "",
      summary: card.querySelector(".draft-summary:not(.draft-fx-summary)")?.textContent?.trim() ?? "",
      alert: card.querySelector("[role=alert]")?.textContent?.trim() ?? "",
      buttons: [...card.querySelectorAll<HTMLButtonElement>("button")].map((button) => ({
        text: button.textContent?.trim() || button.getAttribute("aria-label") || "",
        seen: seen(button),
        clickable: !button.disabled && getComputedStyle(button).pointerEvents !== "none",
      })),
      layer: Boolean(card.querySelector(".draft-fx")),
      // The send-off's own animations, not CSS ones.
      animations: card.getAnimations({ subtree: true }).filter((item) => item.playState === "running" && !(item instanceof CSSAnimation) && !(item instanceof CSSTransition)).length,
      actor: (() => { const box = card.querySelector("[data-fx-actor]")?.getBoundingClientRect(); return box ? [box.width, box.height] : null; })(),
      height: Math.round(card.getBoundingClientRect().height),
      layoutHeight: card.offsetHeight,
      // The height the flight closes the card from, once it has started.
      closesFrom: (() => { const frames = card.getAnimations().flatMap((item) => (item.effect as KeyframeEffect).getKeyframes()); const first = frames.find((frame) => "height" in frame); return first ? Number.parseFloat(String(first.height)) : null; })(),
      requests: control.requests,
    };
  },
};
