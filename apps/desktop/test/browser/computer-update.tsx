import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OPENTEAM_API_PROTOCOL_VERSION } from "@openteam/contracts/version-compatibility";
import "../../src/renderer/styles.css";
if (window.openteam) throw new Error("Synthetic fixture requires an isolated window");
window.open = () => null;
localStorage.setItem("openteam:server-url", "https://openteam.example");

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
      destinations: string[];
      payloads: unknown[];
      offline: boolean;
      server: (next: Partial<ServerStatus>) => void;
    };
  }
}

let server: ServerStatus = {
  serverUrl: "https://openteam.example",
  currentVersion: "0.46.0",
  targetVersion: "0.47.0",
  apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION,
  minimumClientVersion: null,
  maximumClientVersionExclusive: null,
  recommendedClientVersion: null,
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
  destinations: [] as string[],
  payloads: [] as unknown[],
  offline: false,
  server(next: Partial<ServerStatus>) {
    server = { ...server, ...next };
    window.dispatchEvent(new Event("focus"));
  },
});
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname === "/api/v0/system/version") {
    if (fixture.offline) throw new Error("Server restarting");
    return Response.json({ releaseVersion: server.currentVersion,
      apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION });
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
        message: "Pulling OpenTeam 0.47.0 container images" });
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
