import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Conversation,
  ConversationContent,
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
    assertAtEnd(await record(() => setRows(next)), "m200");
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
