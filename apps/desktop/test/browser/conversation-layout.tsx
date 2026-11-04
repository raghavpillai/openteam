import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Conversation,
  ConversationContent,
  glideConversationToBottom,
  isConversationGliding,
} from "../../src/renderer/components/ai-elements/conversation";
import { VirtualizedTimeline } from "../../src/renderer/components/openteam/virtualized-timeline";
import { useVirtualWindow } from "../../src/renderer/hooks/use-virtual-window";

type Entry = { id: string; type: string; height: number };
type Sample = {
  bottom: number;
  first: number;
  last: number;
  visible: string[];
  rows: number;
  top: number;
};
const reactRoot = createRoot(document.getElementById("root")!);
const root = {
  render: (children: React.ReactNode) =>
    reactRoot.render(<React.StrictMode>{children}</React.StrictMode>),
};
const entries: Entry[] = Array.from({ length: 200 }, (_, i) => ({
  id: `m${i}`,
  type: "message",
  height: 60 + (i % 5) * 65,
}));
const ids = (entry: Entry) => [entry.id];
const mounted = new Set<string>();
let rowMounts = 0;
function Row({ entry }: { entry: Entry }) {
  useEffect(() => {
    mounted.add(entry.id);
    rowMounts++;
  }, [entry.id]);
  return (
    <div data-message-id={entry.id} style={{ height: entry.height || undefined }}>
      {entry.height ? entry.id : `${entry.id} variable-width transcript text. `.repeat(70)}
    </div>
  );
}
const renderEntry = (entry: Entry) => <Row entry={entry} />;
function GenericList({ nested = false }: { nested?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const getKey = useCallback((index: number) => `generic-${index}`, []);
  const estimateSize = useCallback(() => 48, []);
  const { measureElement, totalSize, virtualItems } = useVirtualWindow({
    count: 1000,
    getKey,
    estimateSize,
    scrollRef,
    scopeRef,
    maxItems: 40,
    overscan: 200,
    initialViewportSize: 320,
    suspendOutsideViewport: nested,
  });
  return (
    <div
      data-generic-viewport
      ref={scrollRef}
      style={{ height: 320, width: 400, overflowY: "auto" }}
    >
      {nested && <div style={{ height: 1200 }} />}
      <div ref={scopeRef} style={{ position: "relative", height: totalSize }}>
        {virtualItems.map((item) => (
          <div
            key={item.key}
            data-generic-index={item.index}
            ref={(node) => measureElement(item.index, item.key, node)}
            style={{
              position: "absolute",
              height: 48,
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${item.start}px)`,
            }}
          >
            {item.key}
          </div>
        ))}
      </div>
    </div>
  );
}
let context: ReturnType<typeof useStickToBottomContext>;
function CaptureContext() {
  context = useStickToBottomContext();
  return null;
}
let setRows: (entries: Entry[]) => void;
let setWidth: (width: number) => void;
let olderLoads = 0;
let viewportReports: string[][] = [];
const reportViewport = (ids: readonly string[]) => viewportReports.push([...ids]);
function Fixture({
  id,
  initialEntries = entries,
  focus = null,
  width = 800,
  height = 600,
  older = false,
}: {
  id: string;
  initialEntries?: Entry[];
  width?: number;
  height?: number;
  older?: boolean;
  focus?: { index: number; messageId: string; nonce: number } | null;
}) {
  const [rows, updateRows] = useState(initialEntries);
  const [viewportWidth, updateWidth] = useState(width);
  setRows = updateRows;
  setWidth = updateWidth;
  return (
    <Conversation style={{ height, width: viewportWidth }}>
      <CaptureContext />
      <ConversationContent>
        {rows.length > 0 && (
          <VirtualizedTimeline
            conversationId={id}
            entries={rows}
            focus={focus}
            hasOlder={older}
            onLoadOlder={() => {
              olderLoads++;
              updateRows([
                ...Array.from({ length: 20 }, (_, i) => ({
                  id: `older${i}`,
                  type: "message",
                  height: 160,
                })),
                ...rows.slice(0, -20),
              ]);
            }}
            messageIdsForEntry={ids}
            renderEntry={renderEntry}
            onViewportMessagesChange={reportViewport}
          />
        )}
      </ConversationContent>
    </Conversation>
  );
}
// Isolate the shipping scroll controller from virtual-row measurement timing.
// DOM height changes model decoded media and streamed/incoming content.
function GlideFixture() {
  const [rows, updateRows] = useState(entries.slice(0, 20));
  setRows = updateRows;
  return <Conversation style={{ height: 600, width: 800 }}>
    <CaptureContext />
    <ConversationContent>{rows.map(entry => <Row key={entry.id} entry={entry} />)}</ConversationContent>
  </Conversation>;
}
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const motionSample = (time: number) => {
  const viewport = context.scrollRef.current!;
  return { time, top: viewport.scrollTop, target: viewport.scrollHeight - 1 - viewport.clientHeight };
};
type MotionSample = ReturnType<typeof motionSample>;
async function startSendGlide() {
  root.render(<GlideFixture />);
  await wait(150);
  const previousTarget = context.targetScrollTop;
  const from = context.scrollRef.current!.scrollTop;
  const completed = glideConversationToBottom(context, { awaitGrowth: 1_000, durationMs: 350 });
  flushSync(() => setRows([...entries.slice(0, 20), { id: "send", type: "message", height: 180 }]));
  const frames = [motionSample(await nextFrame())];
  for (let i = 0; i < 5; i++) frames.push(motionSample(await nextFrame()));
  return { completed, previousTarget, from, frames };
}
async function finishSendGlide(completed: Promise<boolean>, frames: MotionSample[]) {
  const deadline = performance.now() + 2500;
  while (isConversationGliding(context.state) && performance.now() < deadline)
    frames.push(motionSample(await nextFrame()));
  assert(!isConversationGliding(context.state) && await completed, "Retargeted send did not settle");
  assert(Math.abs(frames.at(-1)!.target - frames.at(-1)!.top) <= 1, "Retargeted send stopped short");
  const steps = frames.slice(1).map((frame, i) => frame.top - frames[i]!.top);
  assert(steps.every(step => step >= -1 && step < 50), `Send jumped/backtracked: ${JSON.stringify(frames)}`);
  return { frames, maxStep: Math.max(...steps) };
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sample = (): Sample | null => {
  const viewport = context?.scrollRef.current;
  const rows = [...document.querySelectorAll<HTMLElement>("[data-virtual-timeline-index]")];
  if (!viewport || !rows.length) return null;
  const bounds = viewport.getBoundingClientRect();
  return {
    bottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    top: viewport.scrollTop,
    first: Number(rows[0]!.dataset.virtualTimelineIndex),
    last: Number(rows.at(-1)!.dataset.virtualTimelineIndex),
    rows: rows.length,
    visible: rows
      .filter((row) => {
        const b = row.getBoundingClientRect();
        return b.bottom > bounds.top && b.top < bounds.bottom;
      })
      .map((row) => row.querySelector<HTMLElement>("[data-message-id]")!.dataset.messageId!),
  };
};
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const record = async (action: () => void, duration = 150) => {
  const frames: Sample[] = [];
  let running = true;
  let frameId = 0;
  const frame = () => {
    const value = sample();
    if (value) frames.push(value);
    if (running) frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);
  action();
  await wait(duration);
  // A busy CI/desktop can defer a hidden Electron window's frames beyond the
  // settling interval. Keep recording from its first frame instead of passing
  // or failing solely on the wall-clock delay.
  const deadline = performance.now() + 2500;
  while (frames.length < 3 && performance.now() < deadline) await wait(20);
  running = false;
  cancelAnimationFrame(frameId);
  assert(frames.length >= 3, "Expected rendered frames");
  assert(
    frames.every((f) => f.rows <= 80),
    "Mounted row budget exceeded"
  );
  return frames;
};
const unmount = async () => {
  root.render(null);
  await wait(30);
  const deadline = performance.now() + 2500;
  while (sample() !== null && performance.now() < deadline) await wait(20);
  assert(sample() === null, "Transcript did not unmount");
};
const assertAtEnd = (frames: Sample[], id = "m199") => {
  assert(
    frames.every((f) => f.bottom <= 2 && f.visible.includes(id)),
    `Incorrect first/settling frame: ${JSON.stringify(frames)}`
  );
};
const scrollUp = (distance: number) => {
  const viewport = context.scrollRef.current!;
  viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance, bubbles: true }));
  viewport.scrollTop = Math.max(0, viewport.scrollTop - distance);
};
type GlideFrame = { top: number; bottom: number; gap: number; ids: string[]; rows: number };
/** Samples every frame until the glide releases, including any blank band in the viewport. */
const recordGlide = async (action: () => void) => {
  const viewport = context.scrollRef.current!;
  const frames: GlideFrame[] = [];
  let running = true;
  const frame = () => {
    if (!running) return;
    const bounds = viewport.getBoundingClientRect();
    const list = document.querySelector("[data-virtual-timeline-count]")!.getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-virtual-timeline-index]")]
      .map((row) => ({ row, box: row.getBoundingClientRect() }))
      .filter(({ box }) => box.bottom > bounds.top && box.top < bounds.bottom)
      .sort((a, b) => a.box.top - b.box.top);
    let cursor = Math.max(bounds.top, list.top);
    let gap = 0;
    for (const { box } of rows) {
      gap = Math.max(gap, box.top - cursor);
      cursor = Math.max(cursor, box.bottom);
    }
    frames.push({
      top: viewport.scrollTop,
      bottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      gap: Math.max(gap, Math.min(bounds.bottom, list.bottom) - cursor),
      ids: rows.map(
        ({ row }) => row.querySelector<HTMLElement>("[data-message-id]")!.dataset.messageId!
      ),
      rows: document.querySelectorAll("[data-virtual-timeline-index]").length,
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  action();
  await wait(50);
  const deadline = performance.now() + 3000;
  while (isConversationGliding(context.state) && performance.now() < deadline) await wait(20);
  await wait(50);
  running = false;
  assert(!isConversationGliding(context.state), "Glide did not finish");
  // The first frames precede the glide's first step; judge from movement on.
  const start = frames.findIndex(
    (frame, index) => index > 0 && frame.top !== frames[index - 1]!.top
  );
  return frames.slice(Math.max(0, start));
};
const assertGlide = (frames: GlideFrame[]) => {
  const moving = frames.filter(
    (frame, index) => index > 0 && frame.top > frames[index - 1]!.top + 0.5
  );
  const distance = frames.at(-1)!.top - frames[0]!.top;
  const largestStep = Math.max(
    ...frames.slice(1).map((frame, index) => frame.top - frames[index]!.top)
  );
  assert(
    moving.length >= 8 && largestStep < distance * 0.35,
    `Glide was not animated (${moving.length} moving frames, ${largestStep}/${distance}px step)`
  );
  assert(
    frames.every((frame, index) => index === 0 || frame.top >= frames[index - 1]!.top - 0.5),
    "Glide moved backwards"
  );
  assert(
    frames.every((frame) => frame.gap <= 1),
    `Glide showed a blank band: ${JSON.stringify(frames)}`
  );
  assert(frames.every((frame) => frame.rows <= 80), "Glide exceeded the mounted row budget");
  assert(frames.at(-1)!.bottom <= 2, `Glide stopped short: ${JSON.stringify(frames.at(-1))}`);
};
/**
 * React may commit an append one frame after the action. Until then the
 * previous end must stay pinned; from the commit on, the new row must be.
 */
const assertFollowsAppend = (frames: Sample[], id: string, index: number) => {
  const committed = frames.findIndex((frame) => frame.last >= index);
  assert(committed >= 0, `Appended row never rendered: ${JSON.stringify(frames)}`);
  assert(
    frames.slice(0, committed).every((frame) => frame.bottom <= 2),
    `Left the bottom before the append rendered: ${JSON.stringify(frames)}`
  );
  assertAtEnd(frames.slice(committed), id);
};
const reports: object[] = [];
async function run(name: string, action: () => Promise<unknown>) {
  await unmount();
  mounted.clear();
  rowMounts = 0;
  viewportReports = [];
  const value = await action();
  reports.push({
    name,
    passed: true,
    uniqueRowsMounted: mounted.size,
    rowMounts,
    ...(value as object),
  });
}

async function main() {
  await run("other virtual lists retain top alignment and bounded scrolling", async () => {
    root.render(<GenericList />);
    await wait(150);
    const viewport = document.querySelector<HTMLElement>("[data-generic-viewport]")!;
    assert(
      viewport?.scrollTop === 0 && document.querySelector("[data-generic-index='0']"),
      "Generic list did not start at top"
    );
    viewport.scrollTop = 20_000;
    await wait(150);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-generic-index]")];
    assert(rows.length > 0 && rows.length <= 40, "Generic list exceeded its row budget");
    assert(
      Number(rows[0]!.dataset.genericIndex) > 400 && viewport.scrollTop === 20_000,
      "Generic scrolling changed position"
    );
  });
  await run("nested sidebar scopes remain unmounted outside the viewport", async () => {
    root.render(<GenericList nested />);
    await wait(150);
    assert(
      document.querySelectorAll("[data-generic-index]").length === 0,
      "Offscreen scope mounted rows"
    );
    document.querySelector<HTMLElement>("[data-generic-viewport]")!.scrollTop = 1400;
    await wait(150);
    const count = document.querySelectorAll("[data-generic-index]").length;
    assert(count > 0 && count <= 40, "Visible nested scope did not mount a bounded range");
  });
  await run("short conversation stays visible without overflow", async () => {
    const frames = await record(() =>
      root.render(<Fixture id="short" initialEntries={entries.slice(0, 2)} />)
    );
    assertAtEnd(frames, "m1");
    assert(
      frames.every((f) => f.top === 0 && f.visible.includes("m0")),
      "Short transcript was clipped"
    );
  });
  await run("cold chat starts at bottom on every frame", async () => {
    const frames = await record(() => root.render(<Fixture id="cold" />));
    assertAtEnd(frames);
    assert(!mounted.has("m0"), "Opening latest mounted the oldest message");
    assert(
      viewportReports.length > 0 && viewportReports.every((ids) => ids.includes("m199")),
      "Published an uninitialized viewport"
    );
    return { first: frames[0], last: frames.at(-1) };
  });
  await run("cached chat remount starts at bottom with bounded mounts", async () => {
    const frames = await record(() => root.render(<Fixture id="cold" />));
    assertAtEnd(frames);
    assert(rowMounts <= 16, `Warm chat mounted ${rowMounts} rows`);
  });
  await run("delayed history starts at bottom", async () => {
    root.render(<Fixture id="delayed" initialEntries={[]} />);
    await wait(50);
    assertAtEnd(await record(() => setRows(entries)));
  });
  await run("large viewport and tall final message start at bottom", async () => {
    const tall = entries.map((entry, index) =>
      index === 199 ? { ...entry, height: 2100 } : entry
    );
    assertAtEnd(
      await record(() => root.render(<Fixture id="tall" initialEntries={tall} height={1200} />))
    );
  });
  await run("saved reading position survives switch and measurement", async () => {
    await record(() => root.render(<Fixture id="reading" />));
    context.stopScroll();
    context.scrollRef.current!.scrollTop -= 1500;
    await wait(150);
    const before = sample()!;
    const id = before.visible[0]!;
    const offset = () =>
      document.querySelector<HTMLElement>(`[data-message-id=${id}]`)!.getBoundingClientRect().top -
      context.scrollRef.current!.getBoundingClientRect().top;
    const originalOffset = offset();
    await unmount();
    const frames = await record(() => root.render(<Fixture id="reading" />));
    assert(
      frames.every((f) => f.visible.includes(id) && f.bottom > 2),
      `Lost reading position: ${JSON.stringify(frames)}`
    );
    assert(
      Math.abs(offset() - originalOffset) <= 2,
      `Reading anchor moved by ${offset() - originalOffset}px`
    );
  });
  await run("search target is visible on first frame and keeps its position", async () => {
    const frames = await record(
      () => root.render(<Fixture id="search" focus={{ index: 35, messageId: "m35", nonce: 1 }} />),
      300
    );
    assert(
      frames.every((f) => f.visible.includes("m35") && f.bottom > 2),
      `Search lost: ${JSON.stringify(frames)}`
    );
  });
  await run("new messages follow bottom without mounting intermediate history", async () => {
    await record(() => root.render(<Fixture id="append" />));
    const next = [...entries, { id: "m200", type: "message", height: 320 }];
    assertFollowsAppend(await record(() => setRows(next)), "m200", 200);
  });
  await run("scrolling up releases follow during new messages", async () => {
    await record(() => root.render(<Fixture id="unlocked" />));
    const viewport = context.scrollRef.current!;
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -800, bubbles: true }));
    viewport.scrollTop -= 800;
    await wait(120);
    const before = sample()!;
    const frames = await record(() =>
      setRows([...entries, { id: "m200", type: "message", height: 320 }])
    );
    assert(
      frames.every((f) => f.bottom > 2 && f.visible.includes(before.visible[0]!)),
      "New message pulled reader to bottom"
    );
  });
  await run("latest glide animates to the bottom and then follows", async () => {
    await record(() => root.render(<Fixture id="glide" />));
    scrollUp(1200);
    await wait(150);
    const frames = await recordGlide(() => void glideConversationToBottom(context));
    assertGlide(frames);
    assert(context.state.isAtBottom, "Glide did not lock to the bottom");
    assertFollowsAppend(
      await record(() => setRows([...entries, { id: "m200", type: "message", height: 320 }])),
      "m200",
      200
    );
    return { glideFrames: frames.length };
  });
  await run("far latest glide starts near the end without blank frames", async () => {
    await record(() => root.render(<Fixture id="far-glide" />));
    scrollUp(30_000);
    await wait(150);
    const viewport = context.scrollRef.current!;
    const lead = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    // The latest button starts its glide inside an animation frame, after which
    // that frame paints without another chance for the virtual window to render.
    const frames = await recordGlide(() =>
      requestAnimationFrame(() => void glideConversationToBottom(context))
    );
    assertGlide(frames);
    assert(
      frames[0]!.bottom < viewport.clientHeight * 2 && lead > viewport.clientHeight * 10,
      `Far glide traversed the transcript: ${JSON.stringify(frames[0])}`
    );
    return { glideFrames: frames.length };
  });
  await run("a sent row arriving after the glide starts is animated into view", async () => {
    await record(() => root.render(<Fixture id="send-glide" />));
    const frames = await recordGlide(() => {
      void glideConversationToBottom(context, { awaitGrowth: 1_000 });
      setTimeout(() => setRows([...entries, { id: "m200", type: "message", height: 240 }]), 50);
    });
    const arrived = frames.filter((frame) => frame.ids.includes("m200"));
    assert(
      arrived[0] && arrived[0].bottom > 100,
      `Sent row was snapped into view: ${JSON.stringify(arrived.slice(0, 3))}`
    );
    assertGlide(arrived);
    assert(context.state.isAtBottom, "Send glide did not lock to the bottom");
  });
  await run("a single send retains its 350ms smoothstep", async () => {
    const { completed, previousTarget, from, frames } = await startSendGlide();
    const result = await finishSendGlide(completed, frames);
    const distance = frames[0]!.target - from;
    for (const frame of frames) {
      const t = Math.min(1, (frame.time - frames[0]!.time) / 350);
      const expected = from + distance * t * t * (3 - 2 * t);
      assert(Math.abs(frame.top - expected) <= 1, `Normal send curve changed: ${JSON.stringify(frame)}`);
    }
    assert(context.targetScrollTop === previousTarget, "Normal send did not restore the scroll target");
    return result;
  });
  await run("send keeps moving through continuous target growth", async () => {
    const { completed, previousTarget, frames } = await startSendGlide();
    const growthFrames = [frames.at(-1)!];
    const before = frames.at(-2)!;
    const atRetarget = frames.at(-1)!;
    const incomingSpeed = (atRetarget.top - before.top) / (atRetarget.time - before.time);
    const row = document.querySelector<HTMLElement>('[data-message-id="send"]')!;
    for (let i = 1; i <= 18; i++) {
      row.style.height = `${180 + i * 8}px`;
      const frame = motionSample(await nextFrame());
      frames.push(frame);
      growthFrames.push(frame);
    }
    const progress = growthFrames.at(-1)!.top - growthFrames[0]!.top;
    const first = growthFrames[1]!;
    const retargetSpeed = (first.top - atRetarget.top) / (first.time - atRetarget.time);
    assert(retargetSpeed >= incomingSpeed * .8, "Retarget discarded the send's existing velocity");
    assert(growthFrames.every((frame, i) => i === 0 || frame.target > growthFrames[i - 1]!.target),
      "Continuous growth did not change the target every frame");
    assert(growthFrames.slice(1).every((frame, i) => frame.top > growthFrames[i]!.top + .5) && progress > 100,
      `Send stalled while target grew: ${JSON.stringify(growthFrames)}`);
    const result = await finishSendGlide(completed, frames);
    assert(context.targetScrollTop === previousTarget && context.state.isAtBottom, "Growth did not restore bottom follow");
    return { progressDuringGrowth: progress, ...result };
  });
  await run("delayed incoming row and decoded media retarget a moving send", async () => {
    const { completed, previousTarget, frames } = await startSendGlide();
    const beforeIncoming = frames.at(-1)!;
    flushSync(() => setRows([...entries.slice(0, 20), { id: "send", type: "message", height: 180 },
      { id: "incoming-media", type: "message", height: 90 }]));
    for (let i = 0; i < 5; i++) frames.push(motionSample(await nextFrame()));
    assert(frames.at(-1)!.top > beforeIncoming.top + 20, "Delayed incoming row stopped the send");
    const beforeMedia = frames.at(-1)!;
    document.querySelector<HTMLElement>('[data-message-id="incoming-media"]')!.style.height = "270px";
    frames.push(motionSample(await nextFrame()));
    assert(frames.at(-1)!.top > beforeMedia.top + .5, "Decoded media reset the send velocity");
    const result = await finishSendGlide(completed, frames);
    assert(context.targetScrollTop === previousTarget, "Delayed growth did not restore the scroll target");
    return result;
  });
  for (const interruption of ["wheel", "replacement", "unmount"] as const) {
    await run(`retargeted send cancels on ${interruption}`, async () => {
      const { completed, previousTarget, frames } = await startSendGlide();
      const viewport = context.scrollRef.current!;
      document.querySelector<HTMLElement>('[data-message-id="send"]')!.style.height = "300px";
      frames.push(motionSample(await nextFrame()));
      let replacement: Promise<boolean> | undefined;
      if (interruption === "wheel") viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      else if (interruption === "replacement") replacement = glideConversationToBottom(context);
      else flushSync(() => root.render(null));
      await nextFrame();
      assert(!await completed, `${interruption} did not cancel the retargeted send`);
      if (replacement) await finishSendGlide(replacement, frames);
      const stopped = viewport.scrollTop;
      await wait(100);
      assert(!isConversationGliding(context.state) && context.targetScrollTop === previousTarget,
        `${interruption} leaked glide ownership`);
      assert(Math.abs(viewport.scrollTop - stopped) <= 1, `${interruption} left a running animation`);
    });
  }
  await run("reader input cancels a glide", async () => {
    await record(() => root.render(<Fixture id="cancel-glide" />));
    scrollUp(1500);
    await wait(150);
    void glideConversationToBottom(context);
    await wait(90);
    context.scrollRef.current!.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, bubbles: true })
    );
    const stopped = context.scrollRef.current!.scrollTop;
    await wait(300);
    assert(
      Math.abs(context.scrollRef.current!.scrollTop - stopped) <= 1 && sample()!.bottom > 2,
      "Glide kept moving after reader input"
    );
  });
  await run("late row growth keeps bottom pinned", async () => {
    await record(() => root.render(<Fixture id="growth" />));
    document.querySelector<HTMLElement>("[data-message-id=m199]")!.style.height = "1600px";
    await wait(180);
    assertAtEnd([sample()!]);
  });
  await run("changed cached content is remeasured before painting", async () => {
    const changed = entries.map((e, i) => (i >= 194 ? { ...e, height: 530 } : e));
    assertAtEnd(
      await record(() => root.render(<Fixture id="cold" initialEntries={changed} width={530} />))
    );
  });
  await run("cached wrapped messages are invalidated at a different width", async () => {
    const fluid = entries.map((e) => ({ ...e, height: 0 }));
    assertAtEnd(await record(() => root.render(<Fixture id="width" initialEntries={fluid} />)));
    const before = document.querySelector<HTMLElement>("[data-message-id=m199]")!.clientHeight;
    await unmount();
    assertAtEnd(
      await record(() => root.render(<Fixture id="width" initialEntries={fluid} width={420} />))
    );
    const after = document.querySelector<HTMLElement>("[data-message-id=m199]")!.clientHeight;
    assert(after > before, "Wrapped row did not change height with width");
  });
  await run("live width resize while following latest stays at bottom", async () => {
    const fluid = entries.map((e) => ({ ...e, height: 0 }));
    assertAtEnd(
      await record(() => root.render(<Fixture id="live-width-bottom" initialEntries={fluid} />))
    );
    assertAtEnd(await record(() => setWidth(420)));
    assertAtEnd(await record(() => setWidth(800)));
  });
  await run("live width resize preserves a reading anchor", async () => {
    const fluid = entries.map((e) => ({ ...e, height: 0 }));
    await record(() => root.render(<Fixture id="live-width-reader" initialEntries={fluid} />));
    context.stopScroll();
    context.scrollRef.current!.scrollTop -= 1600;
    await wait(150);
    const id = sample()!.visible[0]!;
    const before =
      document.querySelector<HTMLElement>(`[data-message-id=${id}]`)!.getBoundingClientRect().top -
      context.scrollRef.current!.getBoundingClientRect().top;
    await record(() => setWidth(420));
    const row = document.querySelector<HTMLElement>(`[data-message-id=${id}]`);
    assert(
      row && sample()!.visible.includes(id),
      `Width resize lost reading anchor ${id}: ${JSON.stringify(sample())}`
    );
    const after =
      row!.getBoundingClientRect().top - context.scrollRef.current!.getBoundingClientRect().top;
    assert(Math.abs(before - after) <= 2, `Width resize moved reading anchor ${after - before}px`);
    await record(() => setWidth(800));
    const restored = document.querySelector<HTMLElement>(`[data-message-id=${id}]`);
    assert(restored && sample()!.visible.includes(id), "Widening lost the reading anchor");
    const restoredOffset =
      restored!.getBoundingClientRect().top -
      context.scrollRef.current!.getBoundingClientRect().top;
    assert(
      Math.abs(before - restoredOffset) <= 2,
      `Widening moved reading anchor ${restoredOffset - before}px`
    );
  });
  await run("ten thousand messages open at latest with bounded rendering", async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      id: `m${i}`,
      type: "message",
      height: 80 + (i % 120),
    }));
    assertAtEnd(
      await record(() => root.render(<Fixture id="scale" initialEntries={many} />)),
      "m9999"
    );
    assert(mounted.size <= 80, `Cold open mounted ${mounted.size} rows`);
  });
  await run("repeated chat switches keep every opening frame at bottom", async () => {
    for (let i = 0; i < 12; i++) {
      await unmount();
      const id = `switch-${i % 3}`;
      assertAtEnd(await record(() => root.render(<Fixture key={id} id={id} />), 60));
    }
  });
  await run("history prepend with eviction retains visible anchor", async () => {
    await record(() => root.render(<Fixture id="paging" older />));
    context.stopScroll();
    context.scrollRef.current!.scrollTop -= 6000;
    await wait(100);
    const id = sample()!.visible[0]!;
    const offset = () =>
      document.querySelector<HTMLElement>(`[data-message-id=${id}]`)!.getBoundingClientRect().top -
      context.scrollRef.current!.getBoundingClientRect().top;
    const before = offset();
    const loads = olderLoads;
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Load older messages"
    )!;
    button.click();
    // A paging anchor must survive deferred row measurement, not just insertion.
    await wait(2600);
    assert(Math.abs(offset() - before) <= 2, `Prepend moved anchor by ${offset() - before}px`);
    assert(olderLoads === loads + 1, "Prepend triggered extra history loads");
  });
  await unmount();
}
void main().then(
  () => {
    (window as any).layoutResults = { reports };
  },
  (error) => {
    (window as any).layoutResults = { reports, error: String(error), stack: error.stack };
  }
);
