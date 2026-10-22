import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OPENTEAM_API_PROTOCOL_VERSION } from "@openteam/contracts/version-compatibility";
import "../../src/renderer/styles.css";
if (window.openteam) throw new Error("Synthetic fixture requires an isolated window");
window.open = () => null;

type Bot = { botId: string; name: string; runIds: string[] };
type ServerStatus = Record<string, unknown> & { status: string; currentVersion: string | null };
declare global {
  interface Window {
    fixture: {
      ready?: boolean;
      busy: Bot[];
      busyChecks: number;
      stops: string[];
      stopDelayMs: number;
      stopClears: boolean;
      updates: Array<{ targetVersion: string | null }>;
      failUpdate: string | null;
      server: (next: Partial<ServerStatus>) => void;
    };
  }
}

const serverListeners = new Set<(status: ServerStatus) => void>();
let server: ServerStatus = {
  serverUrl: "http://127.0.0.1:8787",
  currentVersion: "0.46.0",
  targetVersion: "0.47.0",
  apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION,
  minimumClientVersion: null,
  maximumClientVersionExclusive: null,
  recommendedClientVersion: null,
  updateMethod: "local",
  updaterAvailable: true,
  status: "ready",
  phase: null,
  message: null,
  manualCommand: "openteam update --version 0.47.0",
  jobId: null,
  safeToCloseDesktop: false,
};

// All native update calls and API requests are synthetic. Nothing is updated or stopped.
const fixture = (window.fixture = {
  busy: [] as Bot[],
  busyChecks: 0,
  stops: [] as string[],
  stopDelayMs: 0,
  stopClears: true,
  updates: [] as Array<{ targetVersion: string | null }>,
  failUpdate: null as string | null,
  server(next: Partial<ServerStatus>) {
    server = { ...server, ...next };
    for (const listener of serverListeners) listener(server);
  },
});
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname === "/api/v0/system/busy-bots") {
    fixture.busyChecks++;
    return Response.json({ bots: fixture.busy });
  }
  const stop = url.pathname.match(/^\/api\/v0\/bots\/([^/]+)\/stop$/);
  if (stop && init?.method === "POST") {
    const botId = decodeURIComponent(stop[1]!);
    fixture.stops.push(botId);
    await new Promise((resolve) => setTimeout(resolve, fixture.stopDelayMs));
    if (fixture.stopClears) fixture.busy = fixture.busy.filter((bot) => bot.botId !== botId);
    return Response.json({ hadActiveRun: true });
  }
  throw new Error(`Network disabled in computer update fixture: ${url.pathname}`);
};
window.openteam = {
  versions: { app: "0.47.0" },
  updates: {
    status: async () => ({ currentVersion: "0.47.0", latestVersion: "0.47.0", status: "up-to-date", progress: null, message: null, failureKind: null, track: "stable", downloadUrl: null }),
    onClientProgress: () => () => {},
    serverStatus: async () => server,
    onServerProgress(listener: (status: ServerStatus) => void) {
      serverListeners.add(listener);
      return () => serverListeners.delete(listener);
    },
    async updateServer(input: { targetVersion: string | null }) {
      fixture.updates.push({ targetVersion: input.targetVersion });
      if (fixture.failUpdate) {
        fixture.server({ status: "error", message: fixture.failUpdate });
        throw new Error(`Error invoking remote method 'openteam:update-server': Error: ${fixture.failUpdate}`);
      }
      fixture.server({ status: "updating", phase: "pulling", message: "Pulling OpenTeam 0.47.0 container images" });
      return server;
    },
  },
} as unknown as NonNullable<Window["openteam"]>;

const [{ ComputerUpdateSettings }, { SidebarBotOrderContext }] = await Promise.all([
  import("../../src/renderer/components/openteam/settings/computer-update"),
  import("../../src/renderer/lib/sidebar-bot-order"),
]);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Scout sits above Chief of Staff in the sidebar, although Chief of Staff started first. */}
    <SidebarBotOrderContext.Provider value={["b-scout", "b-chief"]}>
      <main className="mx-auto max-w-[720px] p-8">
        <ComputerUpdateSettings />
      </main>
    </SidebarBotOrderContext.Provider>
  </StrictMode>
);
window.fixture.ready = true;
