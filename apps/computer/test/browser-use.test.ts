import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  assertAllowedCdpMethod,
  BROWSER_USE_TOOLS,
  BrowserUseSession,
  sameOriginFrame,
  truncateAriaSnapshot,
} from "../src/browser-use";

const EXPECTED_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_mouse_click_xy",
  "browser_type",
  "browser_fill",
  "browser_select_option",
  "browser_press_key",
  "browser_scroll",
  "browser_drag",
  "browser_get_bounding_box",
  "browser_highlight",
  "browser_cdp",
  "browser_tabs",
  "browser_take_screenshot",
];

describe("browser-use tool surface", () => {
  test("exposes the complete page-level browser tool set", () => {
    expect(BROWSER_USE_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    const navigate = BROWSER_USE_TOOLS.find((tool) => tool.name === "browser_navigate");
    if (!navigate) throw new Error("browser_navigate tool is missing");
    expect(
      Value.Check(Type.Unsafe<Record<string, unknown>>(navigate.inputSchema), {
        url: "https://example.com",
        newTab: true,
      })
    ).toBe(true);
    expect(
      Value.Check(Type.Unsafe<Record<string, unknown>>(navigate.inputSchema), { newTab: true })
    ).toBe(false);
  });

  test("allows tab-scoped inspection and blocks privileged CDP domains", () => {
    expect(() => assertAllowedCdpMethod("Runtime.evaluate")).not.toThrow();
    expect(() => assertAllowedCdpMethod("Performance.getMetrics")).not.toThrow();
    for (const method of [
      "Input.dispatchMouseEvent",
      "Browser.close",
      "Storage.getCookies",
      "Target.createTarget",
      "Network.getAllCookies",
      "Network.clearBrowserCache",
    ]) {
      expect(() => assertAllowedCdpMethod(method)).toThrow("not allowed");
    }
  });

  test("applies snapshot depth and same-origin frame rules", () => {
    expect(
      truncateAriaSnapshot(
        '- document:\n  - navigation "Primary":\n    - link "Home"\n      - text: nested',
        2
      )
    ).toBe('- document:\n  - navigation "Primary":\n    - … deeper structure omitted');
    expect(sameOriginFrame("https://example.com/app", "https://example.com/frame")).toBe(true);
    expect(sameOriginFrame("https://example.com/app", "about:srcdoc")).toBe(true);
    expect(sameOriginFrame("https://example.com/app", "https://accounts.example.net/")).toBe(false);
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
      pages(): FakePage[];
      newPage(): Promise<FakePage>;
    }
    const allPages: FakePage[] = [];
    const context: FakeContext = {
      pages: () => allPages,
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
