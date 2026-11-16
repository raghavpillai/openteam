import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { OPENTEAM_API_PROTOCOL_VERSION } from "@openteam/contracts/version-compatibility";
import "../../src/renderer/styles.css";

// Desktop self-update (sidebar badge, ready dialog, Settings) or, with &view=server, the server
// update card. Every native update call and API request is synthetic: nothing is downloaded,
// installed, updated or stopped.
if (window.openteam) throw new Error("Synthetic fixture requires an isolated window");
window.open = () => null;
document.documentElement.dataset.theme = "dark";
const params = new URLSearchParams(location.search);
type Bot = { botId: string; name: string; runIds: string[] };
type ServerStatus = Record<string, unknown> & { status: string; currentVersion: string | null };
declare global {
  interface Window {
    fixture: Record<string, any> & { ready?: boolean };
  }
}

const listeners = new Set<(status: OpenTeamUpdateStatus) => void>();
let desktop: OpenTeamUpdateStatus;
const desktopUpdates = {
  status: async () => desktop,
  check: async () => desktop,
  onClientProgress(listener: (status: OpenTeamUpdateStatus) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
const emit = (next: Partial<OpenTeamUpdateStatus>) => {
  desktop = { ...desktop, ...next };
  for (const listener of listeners) listener(desktop);
};
const render = (content: ReactNode) =>
  createRoot(document.getElementById("root")!).render(<StrictMode>{content}</StrictMode>);

if (params.get("view") === "server") {
  localStorage.setItem("openteam:server-url", "https://openteam.example");
  let server: ServerStatus = {
    serverUrl: "https://openteam.example",
    currentVersion: "0.0.10",
    targetVersion: "0.0.11",
    apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION,
    minimumClientVersion: null,
    maximumClientVersionExclusive: null,
    recommendedClientVersion: null,
    updaterAvailable: true,
    status: "ready",
    phase: null,
    message: null,
    manualCommand: "openteam update --version 0.0.11",
    jobId: null,
    safeToCloseDesktop: false,
  };
  desktop = {
    currentVersion: "0.0.11", latestVersion: null, status: "idle", progress: null,
    message: null, failureKind: null, track: "stable", downloadUrl: null,
  };
  const resume = params.get("resume");
  if (resume === "live") server = { ...server, status: "updating", phase: "verifying", message: "Checking all services…", jobId: "resumed-job", safeToCloseDesktop: true };
  if (resume === "complete") server = { ...server, status: "updated", phase: "complete", currentVersion: "0.0.11" };
  if (params.has("unknown")) server.currentVersion = null;
  const fixture = (window.fixture = {
    busy: [] as Bot[],
    busyChecks: 0,
    stops: [] as string[],
    stopDelayMs: 0,
    updates: [] as Array<{ targetVersion: string | null }>,
    failUpdate: null as string | null,
    destinations: [] as string[],
    payloads: [] as unknown[],
    offline: resume === "offline",
    versionOffline: false,
    links: [] as string[],
    desktop: emit,
    server(next: Partial<ServerStatus>) {
      server = { ...server, ...next };
      window.dispatchEvent(new Event("focus"));
    },
  });
  window.addEventListener("openteam:deep-link", (event) => {
    fixture.links.push((event as CustomEvent<{ url: string }>).detail.url);
  });
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/v0/system/version") {
      if (fixture.offline || fixture.versionOffline) throw new Error("Server restarting");
      return Response.json({ releaseVersion: server.currentVersion, apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION });
    }
    if (url.pathname === "/api/v0/system/update") {
      if (fixture.offline) throw new Error("Server restarting");
      if (init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        fixture.updates.push({ targetVersion: input.targetVersion });
        fixture.destinations.push(url.href);
        fixture.payloads.push(input);
        if (fixture.failUpdate) {
          fixture.server({ status: "error", message: fixture.failUpdate });
          return Response.json({ error: { code: "update_failed", message: fixture.failUpdate } }, { status: 503 });
        }
        fixture.server({ status: "updating", phase: "pulling", safeToCloseDesktop: true,
          message: "Pulling OpenTeam 0.0.11 container images" });
      }
      return Response.json(server);
    }
    if (url.pathname === "/api/v0/system/busy-bots") {
      fixture.busyChecks++;
      return Response.json({ bots: fixture.busy });
    }
    const stop = url.pathname.match(/^\/api\/v0\/bots\/([^/]+)\/stop$/);
    if (stop && init?.method === "POST") {
      const botId = decodeURIComponent(stop[1]!);
      fixture.stops.push(botId);
      await new Promise((resolve) => setTimeout(resolve, fixture.stopDelayMs));
      fixture.busy = fixture.busy.filter((bot) => bot.botId !== botId);
      return Response.json({ hadActiveRun: true });
    }
    throw new Error(`Network disabled in server update fixture: ${url.pathname}`);
  };
  window.openteam = { versions: { app: "0.0.11" }, updates: desktopUpdates } as unknown as NonNullable<Window["openteam"]>;
  const [{ default: UpdatesSettings }, { SidebarBotOrderContext }] = await Promise.all([
    import("../../src/renderer/components/openteam/settings/updates"),
    import("../../src/renderer/lib/sidebar-bot-order"),
  ]);
  render(
    // Scout sits above Chief of Staff in the sidebar, although Chief of Staff started first.
    <SidebarBotOrderContext.Provider value={["b-scout", "b-chief"]}>
      <main className="mx-auto max-w-[720px] p-8">
        <UpdatesSettings />
      </main>
    </SidebarBotOrderContext.Provider>
  );
} else {
  window.fetch = async () => {
    throw new Error("Network disabled in update fixture");
  };
  desktop = {
    currentVersion: "0.46.0", latestVersion: "0.47.0", status: "available", progress: null,
    message: null, failureKind: null, track: "stable", downloadUrl: "https://example.invalid",
  };
  const fixture = (window.fixture = { installs: 0, downloads: 0, failDownload: false, failInstall: false, emit });
  window.openteam = {
    versions: { app: "0.46.0" },
    updates: {
      ...desktopUpdates,
      async openDownload() {
        fixture.downloads++;
        if (fixture.failDownload) throw new Error("Test download failed");
        emit({ status: "downloading", progress: 42 });
      },
      async installClient() {
        fixture.installs++;
        if (fixture.failInstall) throw new Error("Test restart failed");
        emit({ status: "installing" });
      },
      serverStatus: async () => ({ currentVersion: "0.46.0", apiProtocolVersion: 1, status: "idle", updateMethod: "local" }),
      onServerProgress: () => () => {},
    },
  } as unknown as NonNullable<Window["openteam"]>;
  const [
    { AccountMenu },
    { DesktopUpdateDialog },
    { TooltipProvider },
    { default: UpdatesSettings },
    { Button },
  ] = await Promise.all([
    import("../../src/renderer/components/openteam/sidebar"),
    import("../../src/renderer/components/openteam/desktop-update-dialog"),
    import("../../src/renderer/components/ui/tooltip"),
    import("../../src/renderer/components/openteam/settings/updates"),
    import("../../src/renderer/components/ui/button"),
  ]);
  const compact = params.has("compact");
  render(
    <TooltipProvider>
      <DesktopUpdateDialog />
      {params.has("settings") ? (
        <main className="mx-auto max-w-3xl p-8">
          <UpdatesSettings />
        </main>
      ) : (
        <aside
          className="fixed inset-y-0 left-0 flex flex-col justify-end border-r bg-sidebar"
          data-sidebar-compact={compact}
          style={{ width: compact ? 88 : 280 }}
        >
          <div className="sidebar-account-footer">
            <AccountMenu compact={compact} onOpenSettings={() => {}}>
              <Button
                aria-label="Account"
                id="account"
                className="sidebar-account-button relative w-full rounded-[11px] hover:bg-subtle data-[state=open]:bg-subtle"
                variant="ghost"
              >
                <span className="sidebar-account-avatar">AB</span>
                <span className="sidebar-account-name">Account</span>
              </Button>
            </AccountMenu>
          </div>
        </aside>
      )}
    </TooltipProvider>
  );
}
window.fixture.ready = true;
