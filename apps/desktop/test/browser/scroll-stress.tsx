import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Conversation,
  ConversationContent,
} from "../../src/renderer/components/ai-elements/conversation";
import { VirtualizedTimeline } from "../../src/renderer/components/openteam/virtualized-timeline";
import { MessageImageGallery } from "../../src/renderer/components/openteam/image-attachment";
import { MessageResponse } from "../../src/renderer/components/ai-elements/message";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { api } from "../../src/renderer/client/openteam-api";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { mobileFixture } from "../../../ios/scripts/fixtures/snapshot";
import "../../src/renderer/styles.css";

// Delay real authenticated-image downloads, including decode failures. The
// shipping gallery still owns loading, sizing, decoding and cell recycling.
const originalFetch = window.fetch.bind(window);
let mediaDownloads = 0;
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes("/api/v0/assets/stress-image-")) return originalFetch(input, init);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 600);
    if (init?.signal?.aborted) {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    init?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
  mediaDownloads++;
  return new Response(
    url.includes("broken")
      ? "invalid image"
      : '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="teal"/></svg>',
    { headers: { "Content-Type": "image/svg+xml" } }
  );
};
const root = createRoot(document.getElementById("root")!);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let generation = 0;
let mode = "text";
let pageDelay = 120;
let pageState = { loading: false, start: 0, end: 0 };
let focusNow: (index: number) => void;
const all = Array.from({ length: 1000 }, (_, index) => ({
  id: `stress-${index}`,
  type: "message",
  index,
}));
const messageIds = (entry: (typeof all)[number]) => [entry.id];
function Timeline({ overlay, focused }: { overlay: boolean; focused: boolean }) {
  const [range, setRange] = useState(
    focused ? [440, 560] : [0, mode === "rich" || mode === "media" ? 300 : 1000]
  );
  const [focus, setFocus] = useState(
    focused ? { index: 60, messageId: "stress-500", nonce: 1 } : null
  );
  const [loading, setLoading] = useState(false);
  pageState = { loading, start: range[0]!, end: range[1]! };
  focusNow = (index) =>
    setFocus({ index: index - range[0]!, messageId: `stress-${index}`, nonce: performance.now() });
  const load = async (direction: number) => {
    if (loading) return;
    setLoading(true);
    await pause(pageDelay);
    setRange(([start, end]) =>
      direction < 0 ? [Math.max(0, start - 40), end - 40] : [start + 40, Math.min(1000, end + 40)]
    );
    setLoading(false);
  };
  return (
    <Conversation style={{ height: 650, width: 640 }}>
      <ConversationContent
        overlayScrollbars={overlay}
        scrollClassName="h-full"
        className="px-4 py-6"
      >
        <VirtualizedTimeline
          conversationId={`stress-${generation}`}
          entries={all.slice(range[0], range[1])}
          focus={
            focus
              ? {
                  ...focus,
                  index: all
                    .slice(range[0], range[1])
                    .findIndex((entry) => entry.id === focus.messageId),
                }
              : null
          }
          hasOlder={focused && range[0]! > 0}
          hasNewer={focused && range[1]! < 1000}
          loadingOlder={loading}
          loadingNewer={loading}
          onLoadOlder={() => load(-1)}
          onLoadNewer={() => load(1)}
          messageIdsForEntry={messageIds}
          renderEntry={(entry) => (
            <div
              data-message-id={entry.id}
              data-stress-index={entry.index}
              style={
                mode === "rich" || mode === "media"
                  ? { padding: 12 }
                  : { height: 70 + (entry.index % 5) * 35, padding: 12 }
              }
            >
              {mode === "media" ? (
                <>
                  <p>Image history item {entry.index}</p>
                  <MessageImageGallery
                    images={Array.from({ length: entry.index % 5 === 0 ? 3 : 1 }, (_, image) => ({
                      url: `/api/v0/assets/stress-image-${entry.index}-${image}-${entry.index % 11 === 0 ? "broken" : "ready"}/content`,
                      alt: `Image ${entry.index}-${image}`,
                      ...(entry.index % 7 === 0
                        ? {}
                        : {
                            width: entry.index % 2 ? 400 : 1600,
                            height: entry.index % 2 ? 800 : 900,
                          }),
                    }))}
                  />
                </>
              ) : mode === "rich" ? (
                <MessageResponse>{`## History item ${entry.index}\n\n${"A paragraph with **formatting** and `code`. ".repeat(1 + (entry.index % 5))}\n\n${entry.index % 7 === 0 ? "| Item | Value |\n|---|---|\n| Table | Ready |\n\n$$x^2+y^2$$" : "- First detail\n- Second detail"}`}</MessageResponse>
              ) : (
                `History item ${entry.index}`
              )}
            </div>
          )}
        />
      </ConversationContent>
    </Conversation>
  );
}
const channel = mobileFixture.channels[0]!;
const template = mobileFixture.channelMessages[0]!;
const threadMessages = Array.from({ length: 350 }, (_, index) => ({
  ...template,
  id: `stress-${index}`,
  channelId: channel.id,
  sequence: String(index + 1),
  createdAt: new Date(1700000000000 + index * 1000).toISOString(),
  content: `History item ${index}\n\n${"A reply with variable line wrapping. ".repeat(1 + (index % 6))}`,
  metadata: index ? { replyTo: "stress-0", branched: true } : {},
}));
Object.assign(api, {
  pluginComposer: async () => ({ items: [] }),
  messageDeliveryStatus: async () => ({ status: "not_found", acceptedAtMs: null, message: null }),
});
const empty = new Map();
function Thread() {
  const [focus, setFocus] = useState({ messageId: "stress-175", nonce: 1 });
  focusNow = (index) => setFocus({ messageId: `stress-${index}`, nonce: performance.now() });
  return (
    <TooltipProvider>
      <main style={{ height: 700, width: 900, position: "relative" }}>
        <ChatPane
          channel={channel}
          active
          selectedBot={mobileFixture.bots[0]}
          botById={new Map(mobileFixture.bots.map((bot) => [bot.id, bot]))}
          agentNameById={empty}
          itemsByRun={empty}
          capabilities={CLIENT_CAPABILITIES}
          messages={threadMessages}
          runs={[]}
          subagents={[]}
          runtime={mobileFixture.runtime}
          mutate={async (operation) => operation()}
          focusMessage={focus}
        />
      </main>
    </TooltipProvider>
  );
}
function sample() {
  const port = document.querySelector<HTMLElement>(
    mode === "thread" ? '[data-thread-tray] [role="list"]' : ".conversation-scroll"
  );
  if (!port) return null;
  const bounds = port.getBoundingClientRect();
  const rows = [
    ...port.querySelectorAll<HTMLElement>(
      mode === "thread" ? "[data-virtual-thread-index]" : "[data-virtual-timeline-index]"
    ),
  ];
  const visible = rows
    .map((row) => ({
      index: Number(
        row.getAttribute(
          mode === "thread" ? "data-virtual-thread-index" : "data-virtual-timeline-index"
        )
      ),
      id: Number(
        (
          row
            .querySelector("[data-message-id], [data-thread-message-id]")
            ?.getAttribute(mode === "thread" ? "data-thread-message-id" : "data-message-id") ?? ""
        )
          .split("-")
          .at(-1)
      ),
      y: row.getBoundingClientRect().top - bounds.top,
      height: row.getBoundingClientRect().height,
    }))
    .filter((row) => row.y + row.height > 0 && row.y < bounds.height)
    .sort((a, b) => a.y - b.y);
  return {
    mediaDownloads,
    page: pageState,
    top: port.scrollTop,
    max: port.scrollHeight - port.clientHeight,
    height: bounds.height,
    rows: visible,
    mounted: rows.length,
    ready:
      mode === "thread"
        ? port.firstElementChild?.getAttribute("aria-hidden") === "false"
        : !!port.querySelector('[data-chat-layout-ready="true"]'),
    x: bounds.x + Math.min(150, bounds.width / 2),
    y: bounds.y + bounds.height / 2,
  };
}
let frames: any[] = [];
let recording = false;
let phase = "";
function tick() {
  if (recording) {
    frames.push({ time: performance.now(), phase, ...sample() });
    requestAnimationFrame(tick);
  }
}
(window as any).scrollHarness = {
  async mount(nextMode: string, overlay: boolean) {
    root.render(null);
    await pause(40);
    mode = nextMode;
    phase = "";
    generation++;
    root.render(
      <StrictMode>
        {mode === "thread" ? (
          <Thread />
        ) : (
          <Timeline overlay={overlay} focused={mode === "search"} />
        )}
      </StrictMode>
    );
  },
  pageDelay: (value: number) => {
    pageDelay = value;
  },
  phase: (value: string) => {
    phase = value;
  },
  sample,
  focus: (index: number) => focusNow(index),
  start() {
    frames = [];
    recording = true;
    requestAnimationFrame(tick);
  },
  stop() {
    recording = false;
    return frames;
  },
};
