import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  BROWSER_USE_TOOLS,
  BrowserUseSession,
  formWriteFrameAllowed,
  truncateAriaSnapshot,
} from "../../src/browser/use";

const EXPECTED_TOOLS = [
  "browser_console_messages",
  "browser_handle_dialog",
  "browser_file_upload",
  "browser_find",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_navigate",
  "browser_navigate_back",
  "browser_run_code",
  "browser_take_screenshot",
  "browser_snapshot",
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
  "browser_wait_for",
];

describe("browser-use tool surface", () => {
  test("exposes the page-level browser tools, with browser_run_code primary and the rest as fallbacks", () => {
    expect(BROWSER_USE_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    const tool = (name: string) => BROWSER_USE_TOOLS.find((candidate) => candidate.name === name)!;
    const check = (name: string, args: Record<string, unknown>) =>
      Value.Check(Type.Unsafe<Record<string, unknown>>(tool(name).inputSchema), args);
    expect(check("browser_navigate", { url: "https://example.com" })).toBe(true);
    expect(check("browser_navigate", { url: "https://example.com", newTab: true })).toBe(false);
    expect(check("browser_click", { target: "e1", element: "Save" })).toBe(true);
    expect(check("browser_click", { target: "e1" })).toBe(false);
    expect(check("browser_drag", { startTarget: "e1", startElement: "Card", endTarget: "e2" })).toBe(true);
    expect(check("browser_wait_for", { time: 11 })).toBe(false);
    for (const name of ["browser_snapshot", "browser_take_screenshot", "browser_console_messages", "browser_find", "browser_file_upload"])
      expect(tool(name).description).not.toStartWith("Fallback only");
    for (const name of ["browser_click", "browser_type", "browser_navigate", "browser_tabs", "browser_wait_for"])
      expect(tool(name).description).toStartWith("Fallback only: use for a step that failed in two browser_run_code scripts");
    expect(JSON.stringify(BROWSER_USE_TOOLS)).not.toContain("viewId");
  });

  test("applies snapshot depth and the form write-frame rule", () => {
    expect(
      truncateAriaSnapshot(
        '- document:\n  - navigation "Primary":\n    - link "Home"\n      - text: nested',
        2
      )
    ).toBe('- document:\n  - navigation "Primary":\n    - … deeper structure omitted');
    // Embedded https frames from another site are written, like a checkout's card frame.
    expect(formWriteFrameAllowed("shop.example", "https://shop.example/pay", "https://js.payments.example/card")).toBe(true);
    expect(formWriteFrameAllowed("www.shop.example", "https://checkout.shop.example/", "blob:https://shop.example/1")).toBe(true);
    expect(formWriteFrameAllowed("shop.example", "https://shop.example/pay", "http://cards.example/")).toBe(false);
    expect(formWriteFrameAllowed("shop.example", "http://shop.example/pay", "https://shop.example/pay")).toBe(false);
    expect(formWriteFrameAllowed("shop.example", "https://evil.example/", "https://shop.example/")).toBe(false);
    expect(formWriteFrameAllowed("127.0.0.1", "http://127.0.0.1:3000/", "http://localhost:4000/card")).toBe(true);
    expect(formWriteFrameAllowed("127.0.0.1", "http://127.0.0.1:3000/", "http://pay.example:4000/card")).toBe(false);
    expect(formWriteFrameAllowed("shop.example", "https://shop.example/", "data:text/html,x")).toBe(false);
  });

  test("keeps concurrent browser workers inside independent tab leases", async () => {
    type Listener = (page?: FakePage) => void;
    interface FakePage {
      isClosed(): boolean;
      on(event: string, listener: Listener): void;
      close(): Promise<void>;
      bringToFront(): Promise<void>;
      title(): Promise<string>;
      url(): string;
      popup(page: FakePage): void;
    }
    const makePage = (name: string): FakePage => {
      let closed = false;
      const listeners = new Map<string, Listener[]>();
      return {
        isClosed: () => closed,
        on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
        close: async () => {
          closed = true;
          for (const listener of listeners.get("close") ?? []) listener();
        },
        bringToFront: async () => undefined,
        title: async () => name,
        url: () => `https://example.com/${name}`,
        popup: (page) => {
          for (const listener of listeners.get("popup") ?? []) listener(page);
        },
      };
    };
    interface FakeContext {
      on(event: string, listener: unknown): void;
      pages(): FakePage[];
      newPage(): Promise<FakePage>;
      newCDPSession(page: FakePage): Promise<unknown>;
    }
    const allPages: FakePage[] = [];
    const context: FakeContext = {
      on: () => {},
      pages: () => allPages,
      newCDPSession: async (page) => ({ on: () => {}, send: async () => ({ targetInfo: { targetId: page.url() } }) }),
      newPage: async () => {
        const page = makePage(`created-${allPages.length}`);
        allPages.push(page);
        return page;
      },
    };
    type TestSession = {
      trackPage(page: FakePage): void;
      ensurePage(viewId?: string): Promise<FakePage>;
      tabs(args: Record<string, unknown>): Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: { tabs: number };
      }>;
    };
    const Session = BrowserUseSession as unknown as new (
      browser: { isConnected(): boolean },
      contextValue: FakeContext,
      artifactDirectory: string
    ) => TestSession;
    const workerCount = 32;
    const workers = Array.from(
      { length: workerCount },
      () => new Session({ isConnected: () => true }, context, "/tmp")
    );
    const pages = workers.map((worker, index) => {
      const page = makePage(`worker-${index}`);
      allPages.push(page);
      worker.trackPage(page);
      return page;
    });

    expect(await Promise.all(workers.map((worker) => worker.ensurePage()))).toEqual(pages);
    expect(
      await Promise.all(
        workers.map(async (worker) => (await worker.tabs({ action: "list" })).details.tabs)
      )
    ).toEqual(Array.from({ length: workerCount }, () => 1));

    for (let index = 0; index < workerCount; index += 4) {
      const popup = makePage(`worker-${index}-popup`);
      allPages.push(popup);
      pages[index]?.popup(popup);
    }
    expect(
      await Promise.all(
        workers.map(async (worker) => (await worker.tabs({ action: "list" })).details.tabs)
      )
    ).toEqual(Array.from({ length: workerCount }, (_, index) => (index % 4 === 0 ? 2 : 1)));
  });
});
