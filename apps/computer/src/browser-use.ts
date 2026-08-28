import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  ElementHandle,
  Frame,
  Locator,
  Page,
} from "playwright-core";

type JsonObject = Record<string, unknown>;

interface OutOfProcessPlaywright {
  playwright: { chromium: BrowserType };
  stop: () => Promise<void>;
}

let playwrightDriver: Promise<OutOfProcessPlaywright> | null = null;

const nodeBinary = (): string => {
  const candidates = [
    process.env.OPENBOT_NODE_BINARY,
    "/usr/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  const resolved = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  );
  if (!resolved) throw new Error("Browser use requires a Node.js executable for Playwright");
  return resolved;
};

const outOfProcessPlaywright = async (): Promise<OutOfProcessPlaywright> => {
  if (!playwrightDriver) {
    playwrightDriver = (async () => {
      const originalFork = childProcess.fork;
      childProcess.fork = ((
        modulePath: string,
        argsOrOptions?: readonly string[] | childProcess.ForkOptions,
        maybeOptions?: childProcess.ForkOptions
      ) => {
        const args = Array.isArray(argsOrOptions)
          ? (argsOrOptions as readonly string[])
          : undefined;
        const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
        return originalFork(modulePath, args, {
          ...(options as childProcess.ForkOptions),
          execPath: nodeBinary(),
        });
      }) as typeof childProcess.fork;
      try {
        const driverModule = (await import("playwright-core/lib/outofprocess")) as unknown as {
          start: () => Promise<OutOfProcessPlaywright>;
        };
        return await driverModule.start();
      } finally {
        childProcess.fork = originalFork;
      }
    })();
  }
  return playwrightDriver;
};

export interface BrowserUseToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const viewId = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description: "Optional tab viewId returned by a prior browser action.",
} as const;
const element = {
  type: "string",
  maxLength: 500,
  description: "Concise description of the target element and intended action.",
} as const;

export const BROWSER_USE_TOOLS: readonly BrowserUseToolDefinition[] = [
  {
    name: "browser_navigate",
    description:
      "Navigate the box browser to a URL. By default reuses your leased tab; set newTab: true to open another leased tab. Returns the resulting page state with a screenshot.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, viewId, newTab: { type: "boolean" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Capture a structured ARIA snapshot with [ref=eN] handles for interactive elements. It pierces open shadow roots and same-origin iframes; cross-origin frames are called out but not inspected. Refs point to exact nodes from this tab's latest snapshot. The explicit >>> selector combinator re-roots each following stage at the previous match.",
    inputSchema: {
      type: "object",
      properties: {
        viewId,
        interactive: { type: "boolean" },
        maxDepth: { type: "number", description: "Maximum snapshot depth. Defaults to 20." },
        selector: { type: "string", maxLength: 1_000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element by ref from browser_snapshot. Scrolls it into view first and returns the resulting page with a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        element,
        offsetX: { type: "number", description: "X offset from the element center." },
        offsetY: { type: "number", description: "Y offset from the element center." },
        doubleClick: { type: "boolean" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Control", "Shift", "Alt", "Meta", "ControlOrMeta"] },
          maxItems: 4,
        },
        holdDurationMs: { type: "integer", minimum: 0, maximum: 10_000 },
        viewId,
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_mouse_click_xy",
    description: "Click at viewport coordinates. Prefer browser_click with refs when possible.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", minimum: 0 },
        y: { type: "number", minimum: 0 },
        element,
        button: { type: "string", enum: ["left", "right", "middle"] },
        viewId,
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "Type text into an editable element by ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string", maxLength: 100_000 },
        element,
        clear: { type: "boolean" },
        submit: { type: "boolean" },
        slowly: { type: "boolean" },
        viewId,
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill",
    description: "Set the value of an editable element by ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string", maxLength: 100_000 },
        element,
        viewId,
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_select_option",
    description: "Select one or more option values or labels in a select element by ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        values: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        element,
        viewId,
      },
      required: ["ref", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press_key",
    description: "Press a key or key chord in the selected browser page.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", minLength: 1, maxLength: 100 }, viewId },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page or scroll a referenced element into view.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        element,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", minimum: 0, maximum: 100_000 },
        deltaX: { type: "number", minimum: -100_000, maximum: 100_000 },
        deltaY: { type: "number", minimum: -100_000, maximum: 100_000 },
        viewId,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_drag",
    description: "Drag an element by ref to another ref or viewport coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        sourceRef: { type: "string" },
        element,
        targetRef: { type: "string" },
        targetX: { type: "number", minimum: 0 },
        targetY: { type: "number", minimum: 0 },
        viewId,
      },
      required: ["sourceRef"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_get_bounding_box",
    description: "Get the viewport bounding box for an element ref.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, element, viewId },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_highlight",
    description: "Highlight an element by ref and return a screenshot showing the highlight.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        element,
        durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
        viewId,
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_cdp",
    description:
      "Send an allowed Chrome DevTools Protocol command to the selected tab. Input, browser-wide, storage, cookie, cache, permission, and target-management commands are denied.",
    inputSchema: {
      type: "object",
      properties: { method: { type: "string" }, params: { type: "object" }, viewId },
      required: ["method"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tabs",
    description: "List, create, close, or select a browser tab.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "close", "select"] },
        index: { type: "integer", minimum: 0 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_take_screenshot",
    description: "Take a viewport or full-page screenshot of the selected page.",
    inputSchema: {
      type: "object",
      properties: { viewId, fullPage: { type: "boolean" } },
      additionalProperties: false,
    },
  },
] as const;

const textResult = (
  text: string,
  details: Record<string, unknown> = {}
): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: "text", text }],
  details,
});

const boundedJson = (value: unknown): string => {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length <= 100_000
    ? serialized
    : `${serialized.slice(0, 100_000)}\n… browser output truncated`;
};

export const assertAllowedCdpMethod = (method: string): void => {
  const denied = [
    /^Input\./,
    /^Browser\./,
    /^Storage\./,
    /^Target\./,
    /^Security\./,
    /^Network\.(?:clearBrowserCache|clearBrowserCookies|deleteCookies|getAllCookies|getCookies|setCookie|setCookies|setExtraHTTPHeaders)$/,
    /^Emulation\.setGeolocationOverride$/,
    /^Page\.setDownloadBehavior$/,
  ];
  if (
    !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method) ||
    denied.some((rule) => rule.test(method))
  ) {
    throw new Error(`CDP method is not allowed: ${method}`);
  }
};

interface SnapshotElement {
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
  disabled: boolean;
}

const INTERACTIVE_SELECTOR =
  'a[href],button,input:not([type="hidden"]),textarea,select,summary,[contenteditable="true"],[role],[tabindex]';

export const truncateAriaSnapshot = (snapshot: string, maxDepth: number): string => {
  const boundedDepth = Math.max(1, Math.min(40, Math.trunc(maxDepth)));
  const kept: string[] = [];
  let omitted = false;
  for (const line of snapshot.split("\n")) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    const depth = Math.floor(indentation / 2) + 1;
    if (depth <= boundedDepth) kept.push(line);
    else omitted = true;
  }
  if (omitted) kept.push(`${"  ".repeat(boundedDepth)}- … deeper structure omitted`);
  return kept.join("\n").trim();
};

export const sameOriginFrame = (pageUrl: string, frameUrl: string): boolean => {
  if (frameUrl === "about:blank" || frameUrl === "about:srcdoc") return true;
  try {
    return new URL(pageUrl).origin === new URL(frameUrl).origin;
  } catch {
    return false;
  }
};

export class BrowserUseSession {
  private readonly ids = new WeakMap<Page, string>();
  private readonly refs = new Map<string, Map<string, ElementHandle<HTMLElement>>>();
  private readonly ownedPages = new Set<Page>();
  private nextViewId = 1;
  private currentViewId: string | null = null;
  private screenshotOrdinal = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly artifactDirectory: string
  ) {}

  static async connect(endpoint: string, artifactDirectory: string): Promise<BrowserUseSession> {
    const driver = await outOfProcessPlaywright();
    const browser = await driver.playwright.chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chromium did not provide a default browser context");
    const session = new BrowserUseSession(browser, context, artifactDirectory);
    session.trackPage(await context.newPage());
    await session.ensurePage();
    return session;
  }

  get connected(): boolean {
    return this.browser.isConnected();
  }

  async execute(toolName: string, raw: unknown): Promise<AgentToolResult<Record<string, unknown>>> {
    const args = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
    switch (toolName) {
      case "browser_navigate":
        return this.navigate(args);
      case "browser_snapshot":
        return this.snapshot(args);
      case "browser_click":
        return this.click(args);
      case "browser_mouse_click_xy":
        return this.mouseClick(args);
      case "browser_type":
        return this.type(args);
      case "browser_fill":
        return this.fill(args);
      case "browser_select_option":
        return this.selectOption(args);
      case "browser_press_key":
        return this.pressKey(args);
      case "browser_scroll":
        return this.scroll(args);
      case "browser_drag":
        return this.drag(args);
      case "browser_get_bounding_box":
        return this.boundingBox(args);
      case "browser_highlight":
        return this.highlight(args);
      case "browser_cdp":
        return this.cdp(args);
      case "browser_tabs":
        return this.tabs(args);
      case "browser_take_screenshot":
        return this.takeScreenshot(args);
      default:
        throw new Error(`Unknown browser-use tool: ${toolName}`);
    }
  }

  private async ensurePage(requestedViewId?: string): Promise<Page> {
    const pages = this.leasedPages();
    if (requestedViewId) {
      const requested = pages.find((page) => this.idFor(page) === requestedViewId);
      if (!requested) throw new Error(`Browser tab is unavailable: ${requestedViewId}`);
      this.currentViewId = requestedViewId;
      return requested;
    }
    const selected = pages.find((page) => this.idFor(page) === this.currentViewId) ?? pages[0];
    if (selected) {
      this.currentViewId = this.idFor(selected);
      return selected;
    }
    const created = await this.context.newPage();
    this.trackPage(created);
    this.currentViewId = this.idFor(created);
    return created;
  }

  private leasedPages(): Page[] {
    const pages = [...this.ownedPages].filter((page) => !page.isClosed());
    for (const page of [...this.ownedPages]) {
      if (page.isClosed()) this.ownedPages.delete(page);
    }
    return pages;
  }

  private trackPage(page: Page): void {
    if (this.ownedPages.has(page)) return;
    this.ownedPages.add(page);
    this.idFor(page);
    page.on("popup", (popup) => {
      this.trackPage(popup);
      this.currentViewId = this.idFor(popup);
    });
    page.on("close", () => {
      this.ownedPages.delete(page);
      this.refs.delete(this.idFor(page));
      if (this.currentViewId === this.idFor(page)) this.currentViewId = null;
    });
  }

  private idFor(page: Page): string {
    const existing = this.ids.get(page);
    if (existing) return existing;
    const id = `view-${this.nextViewId++}`;
    this.ids.set(page, id);
    return id;
  }

  private viewId(args: JsonObject): string | undefined {
    return typeof args.viewId === "string" ? args.viewId : undefined;
  }

  private async clearRefs(page: Page): Promise<void> {
    const refs = this.refs.get(this.idFor(page));
    this.refs.delete(this.idFor(page));
    if (refs) await Promise.allSettled([...refs.values()].map((handle) => handle.dispose()));
  }

  private async requireRef(page: Page, value: unknown): Promise<ElementHandle<HTMLElement>> {
    if (typeof value !== "string") throw new Error("An element ref is required");
    const handle = this.refs.get(this.idFor(page))?.get(value);
    const connected = await handle?.evaluate((node) => node.isConnected).catch(() => false);
    if (!handle || !connected) {
      throw new Error(`Element ref ${value} is stale or unknown; take a fresh browser_snapshot`);
    }
    return handle;
  }

  private async pageState(
    page: Page,
    summary: string,
    fullPage = false
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const image = Buffer.from(await page.screenshot({ fullPage, type: "png" }));
    await mkdir(this.artifactDirectory, { recursive: true });
    const path = join(
      this.artifactDirectory,
      `browser-${Date.now()}-${this.screenshotOrdinal++}.png`
    );
    await writeFile(path, image, { mode: 0o644 });
    const pageViewId = this.idFor(page);
    const title = await page.title().catch(() => "");
    return {
      content: [
        {
          type: "text",
          text: `${summary}\nviewId: ${pageViewId}\nurl: ${page.url()}${title ? `\ntitle: ${title}` : ""}\nscreenshot: ${path}`,
        },
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      ],
      details: { viewId: pageViewId, url: page.url(), title, path },
    };
  }

  private async navigate(args: JsonObject) {
    if (typeof args.url !== "string") throw new Error("url is required");
    const page =
      args.newTab === true
        ? await this.context.newPage().then((created) => {
            this.trackPage(created);
            return created;
          })
        : await this.ensurePage(this.viewId(args));
    this.currentViewId = this.idFor(page);
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.clearRefs(page);
    return this.pageState(page, `Navigated to ${page.url()}`);
  }

  private async snapshot(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const pageViewId = this.idFor(page);
    await this.clearRefs(page);
    const refs = new Map<string, ElementHandle<HTMLElement>>();
    const lines = [
      `Page ${pageViewId}: ${await page.title().catch(() => "")}`,
      `URL: ${page.url()}`,
    ];
    let nextRef = 1;
    const selector = typeof args.selector === "string" ? args.selector : undefined;
    const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 20;
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && !sameOriginFrame(page.url(), frame.url())) {
        lines.push(`[cross-origin frame not inspected: ${frame.url()}]`);
        continue;
      }
      const frameEntries = await this.snapshotFrame(
        frame,
        selector,
        refs,
        nextRef,
        maxDepth,
        args.interactive === true
      );
      nextRef = frameEntries.nextRef;
      if (frameEntries.lines.length > 0) {
        const frameLabel =
          frame === page.mainFrame() ? "Interactive elements:" : `Frame ${frame.url()}:`;
        lines.push(frameLabel, ...frameEntries.lines);
      }
      if (nextRef > 500) {
        lines.push("[interactive snapshot truncated at 500 elements]");
        break;
      }
    }
    this.refs.set(pageViewId, refs);
    const result = await this.pageState(page, lines.join("\n"));
    result.details = { ...result.details, refs: refs.size };
    return result;
  }

  private async snapshotFrame(
    frame: Frame,
    selector: string | undefined,
    refs: Map<string, ElementHandle<HTMLElement>>,
    startRef: number,
    maxDepth: number,
    interactiveOnly: boolean
  ): Promise<{ lines: string[]; nextRef: number }> {
    const lines: string[] = [];
    let nextRef = startRef;
    const scopes = this.deepLocator(frame, selector ?? "body");
    const scopeCount = Math.min(await scopes.count().catch(() => 0), 20);
    for (let scopeIndex = 0; scopeIndex < scopeCount && nextRef <= 500; scopeIndex += 1) {
      const scope = scopes.nth(scopeIndex);
      if (!interactiveOnly) {
        const structure = await scope.ariaSnapshot({ timeout: 5_000 }).catch(() => "");
        const truncated = truncateAriaSnapshot(structure, maxDepth);
        if (truncated) lines.push(`Structure:\n${truncated}`);
      }
      const candidateLocators: Locator[] = [];
      if (
        await scope
          .evaluate((node, match) => node.matches(match), INTERACTIVE_SELECTOR)
          .catch(() => false)
      ) {
        candidateLocators.push(scope);
      }
      const descendants = scope.locator(INTERACTIVE_SELECTOR);
      const descendantCount = Math.min(await descendants.count().catch(() => 0), 500 - nextRef + 1);
      for (let index = 0; index < descendantCount; index += 1) {
        candidateLocators.push(descendants.nth(index));
      }
      for (const locator of candidateLocators) {
        if (nextRef > 500) break;
        if (!(await locator.isVisible().catch(() => false))) continue;
        const handle = (await locator
          .elementHandle()
          .catch(() => null)) as ElementHandle<HTMLElement> | null;
        if (!handle) continue;
        const details = await this.snapshotElement(handle);
        if (!details) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const ref = `e${nextRef++}`;
        refs.set(ref, handle);
        const metadata = [
          details.role ?? details.tag,
          details.type,
          details.disabled ? "disabled" : null,
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(
          `[ref=${ref}] ${metadata}${details.name ? ` ${JSON.stringify(details.name)}` : ""}`
        );
      }
    }
    return { lines, nextRef };
  }

  private deepLocator(frame: Frame, selector: string): Locator {
    const stages = selector
      .split(/\s*>>>\s*/)
      .map((stage) => stage.trim())
      .filter(Boolean);
    const [first, ...rest] = stages;
    if (!first) throw new Error("selector must not be empty");
    let locator = frame.locator(first);
    for (const stage of rest) locator = locator.locator(stage);
    return locator;
  }

  private snapshotElement(handle: ElementHandle<HTMLElement>): Promise<SnapshotElement | null> {
    return handle
      .evaluate((node): SnapshotElement => {
        const element = node as HTMLElement;
        const input = element as HTMLInputElement;
        const type = element.getAttribute("type");
        const text =
          type === "password"
            ? ""
            : (element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              element.getAttribute("placeholder") ??
              element.innerText ??
              element.getAttribute("name") ??
              input.value ??
              "");
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          name: text.replace(/\s+/g, " ").trim().slice(0, 300),
          type,
          disabled: Boolean((element as HTMLButtonElement).disabled),
        };
      })
      .catch(() => null);
  }

  private async click(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    const modifiers = Array.isArray(args.modifiers)
      ? args.modifiers.map((value) => (value === "ControlOrMeta" ? "Control" : value))
      : [];
    if (typeof args.holdDurationMs === "number" && args.holdDurationMs > 0) {
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox();
      if (!box) throw new Error("Referenced element has no visible bounding box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ button: (args.button as "left" | "right" | "middle") ?? "left" });
      await page.waitForTimeout(args.holdDurationMs);
      await page.mouse.up({ button: (args.button as "left" | "right" | "middle") ?? "left" });
    } else {
      const box = await handle.boundingBox();
      await handle.click({
        button: (args.button as "left" | "right" | "middle") ?? "left",
        clickCount: args.doubleClick === true ? 2 : 1,
        modifiers: modifiers as Array<"Alt" | "Control" | "Meta" | "Shift">,
        ...((typeof args.offsetX === "number" || typeof args.offsetY === "number") && box
          ? {
              position: {
                x: box.width / 2 + (typeof args.offsetX === "number" ? args.offsetX : 0),
                y: box.height / 2 + (typeof args.offsetY === "number" ? args.offsetY : 0),
              },
            }
          : {}),
      });
    }
    return this.pageState(page, "Clicked the referenced element");
  }

  private async mouseClick(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.x !== "number" || typeof args.y !== "number")
      throw new Error("x and y are required");
    await page.mouse.click(args.x, args.y, {
      button: (args.button as "left" | "right" | "middle") ?? "left",
    });
    return this.pageState(page, `Clicked viewport coordinates ${args.x},${args.y}`);
  }

  private async type(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    if (typeof args.text !== "string") throw new Error("text is required");
    if (args.clear === true) await handle.fill("");
    await handle.type(args.text, args.slowly === true ? { delay: 40 } : undefined);
    if (args.submit === true) await handle.press("Enter");
    return this.pageState(page, "Typed into the referenced element");
  }

  private async fill(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    if (typeof args.value !== "string") throw new Error("value is required");
    await handle.fill(args.value);
    return this.pageState(page, "Filled the referenced element");
  }

  private async selectOption(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    if (!Array.isArray(args.values) || args.values.some((value) => typeof value !== "string")) {
      throw new Error("values must be an array of strings");
    }
    let selected = await handle.selectOption(args.values as string[]).catch(() => []);
    if (selected.length === 0) {
      selected = await handle.selectOption((args.values as string[]).map((label) => ({ label })));
    }
    return this.pageState(page, `Selected options: ${selected.join(", ")}`);
  }

  private async pressKey(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.key !== "string") throw new Error("key is required");
    const key = args.key
      .replace(/ControlOrMeta/gi, "Control")
      .replace(/\bctrl\b/gi, "Control")
      .replace(/\balt\b/gi, "Alt")
      .replace(/\bshift\b/gi, "Shift")
      .replace(/\bmeta\b/gi, "Meta");
    await page.keyboard.press(key);
    return this.pageState(page, `Pressed ${key}`);
  }

  private async scroll(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.ref === "string") {
      await (await this.requireRef(page, args.ref)).scrollIntoViewIfNeeded();
    }
    const amount = typeof args.amount === "number" ? args.amount : 300;
    const direction = typeof args.direction === "string" ? args.direction : "down";
    const deltaX =
      typeof args.deltaX === "number"
        ? args.deltaX
        : direction === "left"
          ? -amount
          : direction === "right"
            ? amount
            : 0;
    const deltaY =
      typeof args.deltaY === "number"
        ? args.deltaY
        : direction === "up"
          ? -amount
          : direction === "down"
            ? amount
            : 0;
    if (deltaX !== 0 || deltaY !== 0) await page.mouse.wheel(deltaX, deltaY);
    return this.pageState(page, `Scrolled by ${deltaX},${deltaY}`);
  }

  private async drag(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const source = await this.requireRef(page, args.sourceRef);
    const sourceBox = await source.boundingBox();
    if (!sourceBox) throw new Error("Source element has no visible bounding box");
    let targetX: number;
    let targetY: number;
    if (typeof args.targetRef === "string") {
      const targetBox = await (await this.requireRef(page, args.targetRef)).boundingBox();
      if (!targetBox) throw new Error("Target element has no visible bounding box");
      targetX = targetBox.x + targetBox.width / 2;
      targetY = targetBox.y + targetBox.height / 2;
    } else if (typeof args.targetX === "number" && typeof args.targetY === "number") {
      targetX = args.targetX;
      targetY = args.targetY;
    } else {
      throw new Error("Drag requires targetRef or targetX and targetY");
    }
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 8 });
    await page.mouse.up();
    return this.pageState(page, "Dragged the referenced element");
  }

  private async boundingBox(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const box = await (await this.requireRef(page, args.ref)).boundingBox();
    return textResult(boundedJson({ viewId: this.idFor(page), ref: args.ref, box }), {
      viewId: this.idFor(page),
      box,
    });
  }

  private async highlight(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    const original = await handle.evaluate((node) => {
      const element = node as HTMLElement;
      const value = element.style.outline;
      element.style.outline = "4px solid #ff2d55";
      element.style.outlineOffset = "2px";
      return value;
    });
    const result = await this.pageState(page, "Highlighted the referenced element");
    const duration = typeof args.durationMs === "number" ? args.durationMs : 2_000;
    setTimeout(() => {
      void handle
        .evaluate((node, value) => {
          (node as HTMLElement).style.outline = value;
          (node as HTMLElement).style.outlineOffset = "";
        }, original)
        .catch(() => undefined);
    }, duration);
    return result;
  }

  private async cdp(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.method !== "string") throw new Error("method is required");
    assertAllowedCdpMethod(args.method);
    const session = await this.context.newCDPSession(page);
    try {
      const result = await session.send(args.method as never, (args.params ?? {}) as never);
      const state = await this.pageState(page, `CDP ${args.method}\n${boundedJson(result)}`);
      state.details = {
        viewId: this.idFor(page),
        method: args.method,
        result,
      };
      return state;
    } finally {
      await session.detach();
    }
  }

  private async tabs(args: JsonObject) {
    const action = args.action;
    if (action === "new") {
      const page = await this.context.newPage();
      this.trackPage(page);
      this.currentViewId = this.idFor(page);
    } else if (action === "select") {
      if (typeof args.index !== "number") throw new Error("index is required when selecting a tab");
      const page = this.leasedPages()[args.index];
      if (!page) throw new Error(`Browser tab index is unavailable: ${args.index}`);
      this.currentViewId = this.idFor(page);
      await page.bringToFront();
    } else if (action === "close") {
      const pages = this.leasedPages();
      const page = typeof args.index === "number" ? pages[args.index] : await this.ensurePage();
      if (!page) throw new Error("Browser tab is unavailable");
      await this.clearRefs(page);
      await page.close();
      this.currentViewId = null;
      await this.ensurePage();
    } else if (action !== "list") {
      throw new Error("action must be list, new, close, or select");
    }
    const pages = this.leasedPages();
    const entries = await Promise.all(
      pages.map(async (page, index) => ({
        index,
        viewId: this.idFor(page),
        selected: this.idFor(page) === this.currentViewId,
        title: await page.title().catch(() => ""),
        url: page.url(),
      }))
    );
    return textResult(boundedJson({ tabs: entries }), { tabs: entries.length });
  }

  private async takeScreenshot(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    return this.pageState(page, "Captured browser screenshot", args.fullPage === true);
  }
}
