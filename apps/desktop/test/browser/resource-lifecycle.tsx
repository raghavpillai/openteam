import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import type { BotView } from "@openteam/contracts";
import { api } from "../../src/renderer/client/openteam-api";
import { clearAuthToken } from "../../src/renderer/client/auth";
import { useAuthenticatedResource } from "../../src/renderer/hooks/use-authenticated-resource";
import {
  ResourceActivityProvider,
  WindowResourceActivity,
  useResourceActive,
} from "../../src/renderer/hooks/resource-activity";
import { useVisibleNow } from "../../src/renderer/hooks/use-visible-now";
import {
  installWindowVisibility,
  isWindowActive,
  isWindowVisible,
} from "../../src/renderer/lib/window-visibility";
import { highlightAsync } from "../../src/renderer/components/ai-elements/message-response/code-worker-client";
import {
  code,
  getCodeHighlighterCacheStats,
} from "../../src/renderer/components/ai-elements/message-response/code";
import { botShikiTheme } from "../../src/renderer/components/ai-elements/message-response/code-theme";
import { BotScreen } from "../../src/renderer/components/openteam/bot-screen";
import { GroupActivityContent } from "../../src/renderer/components/openteam/group-activity";
import { LoadingOrb, preloadLoadingOrb } from "../../src/renderer/components/ui/loading-orb";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import "../../src/renderer/styles.css";

const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

// Advance long idle deadlines deterministically while native drawing, networking
// and worker jobs use real browser tasks. The unmodified timer mode measures RAM.
const timers = new Map<number, { due: number; callback: () => void }>();
const originalTimeout = window.setTimeout.bind(window);
const originalClearTimeout = window.clearTimeout.bind(window);
const originalNow = Date.now;
let clockOffset = 0;
let nextTimer = -1;
if (!location.search.includes("realtime")) {
  Date.now = () => originalNow() + clockOffset;
  window.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay < 25_000 || delay > 30_000 || typeof callback !== "function") {
      return originalTimeout(callback, delay, ...args);
    }
    const id = nextTimer--;
    timers.set(id, { due: Date.now() + delay, callback: () => callback(...args) });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    timers.delete(id!);
    originalClearTimeout(id);
  };
}
const advance = (ms: number) => {
  clockOffset += ms;
  for (const [id, timer] of [...timers]) {
    if (timer.due <= Date.now() && timers.delete(id)) timer.callback();
  }
};
const intervals = new Map<number, number>();
const originalInterval = window.setInterval.bind(window);
const originalClearInterval = window.clearInterval.bind(window);
window.setInterval = ((callback: () => void, delay: number) => {
  const id = originalInterval(callback, delay);
  intervals.set(id, delay);
  return id;
}) as typeof window.setInterval;
window.clearInterval = (id) => {
  intervals.delete(id!);
  originalClearInterval(id);
};

let holdWorker = false;
const heldMessages: Array<() => void> = [];
const workers = new Set<Worker>();
let workerCreations = 0;
let workerTerminations = 0;
let staleError: ((event: ErrorEvent) => unknown) | null = null;
const BrowserWorker = window.Worker;
window.Worker = class extends BrowserWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers.add(this);
    workerCreations++;
    this.addEventListener("message", (event) => {
      if (!holdWorker) return;
      event.stopImmediatePropagation();
      heldMessages.push(() =>
        this.dispatchEvent(new MessageEvent("message", { data: event.data }))
      );
    });
  }
  terminate() {
    if (workers.delete(this)) workerTerminations++;
    super.terminate();
  }
};

const originalFetch = window.fetch.bind(window);
const imageBlob = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><rect width="64" height="40" fill="teal"/><circle cx="32" cy="20" r="12" fill="white"/></svg>',
  ],
  { type: "image/svg+xml" }
);
const requests: Array<{ path: string; aborted: boolean }> = [];
const heldFetches: Array<() => void> = [];
window.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    location.href
  );
  if (!url.pathname.startsWith("/api/")) return originalFetch(input, options);
  const request = { path: url.pathname + url.search, aborted: false };
  requests.push(request);
  const signal = options?.signal;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise<Response>((resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        request.aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
    const complete = () =>
      resolve(new Response(imageBlob, { headers: { "content-type": "image/svg+xml" } }));
    if (url.pathname.includes("hold")) heldFetches.push(complete);
    else complete();
  });
};

let takeovers = 0;
api.screenStatus = async () => ({ state: "ready" }) as never;
api.screenTakeover = async () => {
  takeovers++;
  return { state: "ready" } as never;
};
api.screenVncSession = async () =>
  ({ path: "/api/v0/bots/fixture/screen/vnc", password: "fixture", protocols: [] }) as never;
api.browserNetwork = async () => null as never;
api.pluginComposer = async () => ({ items: [] }) as never;
const bot = {
  id: "fixture",
  name: "Fixture",
  status: "active",
  color: "orange",
  icon: "helmet",
} as BotView;
const secondBot = {
  id: "second",
  name: "Second",
  status: "active",
  color: "blue",
  icon: "helmet",
} as BotView;
const root = createRoot(document.getElementById("root")!);
let ChatPane:
  | typeof import("../../src/renderer/components/openteam/chat-pane").ChatPane
  | undefined;
let MessageResponse:
  | typeof import("../../src/renderer/components/ai-elements/message").MessageResponse
  | undefined;
const disposeVisibility = installWindowVisibility();
await preloadLoadingOrb();
type Options = {
  sources?: string[];
  retain?: string;
  viewActive?: boolean;
  screen?: boolean;
  group?: boolean;
  chat?: boolean;
  markdown?: string;
};
function Resource({ source, index, retain }: { source: string; index: number; retain?: string }) {
  const enabled = useResourceActive();
  const url = useAuthenticatedResource(source, { enabled, retainPreviousFor: retain });
  return <img data-resource={index} alt="Fixture" src={url ?? undefined} />;
}
function Clock() {
  const now = useVisibleNow(1_000);
  return <output data-now>{now}</output>;
}
const render = (options: Options) =>
  flushSync(() =>
    root.render(
      <StrictMode>
        <TooltipProvider>
          <WindowResourceActivity>
            <Clock />
            <ResourceActivityProvider active={options.viewActive ?? true}>
              {(options.sources ?? []).map((source, index) => (
                <Resource key={index} source={source} index={index} retain={options.retain} />
              ))}
              <LoadingOrb />
            </ResourceActivityProvider>
            {options.markdown && MessageResponse && (
              <div data-code-surface style={{ width: "calc(100% - 24px)", margin: 12 }}>
                <MessageResponse>{options.markdown}</MessageResponse>
              </div>
            )}
            {options.group && (
              <GroupActivityContent
                activity={{
                  workers: [bot, secondBot],
                  readers: [],
                  typing: false,
                  text: "Working",
                }}
              />
            )}
            {options.screen && <BotScreen bot={bot} active enabled onEnable={() => {}} />}
            {options.chat && ChatPane && (
              <ChatPane
                channel={
                  {
                    id: "fixture-chat",
                    kind: "bot_dm",
                    name: "Fixture",
                    members: [{ botId: "fixture", ordinal: 0 }],
                    createdAt: new Date().toISOString(),
                    unreadCount: 0,
                  } as never
                }
                selectedBot={{ ...bot, onboardingStatus: "completed" } as never}
                botById={new Map([["fixture", bot]])}
                agentNameById={new Map([["fixture", "Fixture"]])}
                capabilities={CLIENT_CAPABILITIES}
                messages={[]}
                runs={[]}
                subagents={[]}
                itemsByRun={new Map()}
                runtime={
                  {
                    server: "ready",
                    database: "ready",
                    queue: "ready",
                    computer: "ready",
                    inference: "ready",
                  } as never
                }
                mutate={async (operation) => operation()}
                focusMessage={null}
              />
            )}
          </WindowResourceActivity>
        </TooltipProvider>
      </StrictMode>
    )
  );
let highlightDone = 0;
let highlightError: string | null = null;
const highlight = (source: string, language: string) => {
  void highlightAsync(source, language, botShikiTheme)
    .then(() => {
      highlightDone++;
    })
    .catch((error) => {
      highlightError = String(error);
    });
};
Object.assign(window, {
  renderResourceMarkdown: async (source: string, language = "typescript") => {
    MessageResponse ??= (await import("../../src/renderer/components/ai-elements/message"))
      .MessageResponse;
    render({
      sources: ["/api/fixture/image", "/api/fixture/image"],
      markdown: `\`\`\`${language}\n${source}\n\`\`\``,
    });
  },
  renderResourceChat: async () => {
    ChatPane ??= (await import("../../src/renderer/components/openteam/chat-pane")).ChatPane;
    render({ chat: true, sources: ["/api/fixture/image"] });
  },
  renderResources: render,
  advanceResourceClock: advance,
  completeResourceFetches: () => {
    for (const complete of heldFetches.splice(0)) complete();
  },
  signOutResourceFixture: () => flushSync(() => clearAuthToken()),
  holdHighlightResponses: (hold: boolean) => {
    holdWorker = hold;
    if (!hold) for (const complete of heldMessages.splice(0)) complete();
  },
  captureWorkerError: () => {
    staleError = [...workers][0]?.onerror ?? null;
  },
  emitStaleWorkerError: () => staleError?.(new ErrorEvent("error", { message: "stale worker" })),
  highlightResourceCode: highlight,
  cacheResourceCode: () =>
    code.highlight({ code: "const cached = 1;", language: "typescript", themes: botShikiTheme }),
  unmountResources: () => flushSync(() => root.render(null)),
  disposeResources: () => {
    flushSync(() => root.unmount());
    disposeVisibility();
  },
  resourceProbe: () => ({
    errors,
    active: isWindowActive(),
    visible: isWindowVisible(),
    requests,
    sources: [...document.querySelectorAll<HTMLImageElement>("[data-resource]")].map((image) =>
      image.getAttribute("src")
    ),
    canvasCount: document.querySelectorAll("canvas[role=img]").length,
    intervals: [...intervals.values()],
    longTimers: timers.size,
    workers: workers.size,
    workerCreations,
    workerTerminations,
    heldMessages: heldMessages.length,
    highlightDone,
    highlightError,
    stats: getCodeHighlighterCacheStats(),
    now: document.querySelector("[data-now]")?.textContent,
    takeovers,
    vnc: (window as unknown as { vncFixture?: unknown }).vncFixture,
    draft: document.querySelector('[contenteditable="true"][role="textbox"]')?.textContent ?? null,
  }),
});
render({});
