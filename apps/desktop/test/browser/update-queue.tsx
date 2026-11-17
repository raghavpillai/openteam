import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpCircle,
  ChevronLeft,
  Monitor,
  Radio,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import { OPENTEAM_API_PROTOCOL_VERSION } from "@openteam/contracts/version-compatibility";
import "../../src/renderer/styles.css";

// Real Settings components, isolated native/API fakes. Never downloads or installs a release.
if (window.openteam) throw new Error("Update demo requires an isolated browser window");
localStorage.setItem("openteam:server-url", "https://demo-server.example");
const parameters = new URLSearchParams(location.search);
if (parameters.has("stress")) {
  // Accelerate observation only. The real queue, React events and native/API fakes are unchanged.
  const timeout = window.setTimeout.bind(window);
  const interval = window.setInterval.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    timeout(handler, ms === 1_500 ? 10 : ms, ...args)) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    interval(
      handler,
      ms === 1_500 || ms === 2_000 ? 10 : ms,
      ...args
    )) as typeof window.setInterval;
}
if (!parameters.has("resume")) {
  for (const key of Object.keys(localStorage))
    if (key.startsWith("openteam:update-queue:") || key.startsWith("openteam:server-update:"))
      localStorage.removeItem(key);
}
const listeners = new Set<(next: OpenTeamUpdateStatus) => void>();
let desktop: OpenTeamUpdateStatus = {
  currentVersion: "0.0.18",
  latestVersion: "0.0.19",
  status: "available",
  progress: null,
  message: null,
  failureKind: null,
  track: "stable",
  downloadUrl: "https://example.invalid/demo",
};
let server = {
  currentVersion: parameters.get("scenario") === "desktop" ? "0.0.19" : "0.0.18",
  targetVersion: null as string | null,
  updaterAvailable: true,
  status: "ready",
  phase: null as string | null,
  message: "Updates this connected server",
  jobId: null as string | null,
  safeToCloseDesktop: false,
};
if (parameters.get("scenario") === "server")
  desktop = { ...desktop, latestVersion: "0.0.19", status: "up-to-date" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const demo = {
  ready: false,
  auto: !parameters.has("manual"),
  duration: parameters.has("fast") ? 250 : 2_300,
  busy: false,
  offline: false,
  failServer: false,
  failDownload: false,
  hangDownload: false,
  clockOffset: 0,
  downloads: 0,
  downloadTargets: [] as Array<string | null>,
  installs: 0,
  posts: [] as string[],
  holdBusy: false,
  busyHeld: false,
  releaseBusy: () => {},
  signIn: async (_account: string) => {},
  signOut: async () => {},
  events: [] as string[],
  emit(next: Partial<OpenTeamUpdateStatus>) {
    desktop = { ...desktop, ...next };
    for (const listener of listeners) listener(desktop);
  },
  server(next: Partial<typeof server>) {
    server = { ...server, ...next };
    window.dispatchEvent(new Event("focus"));
  },
  state: () => ({ desktop, server }),
};
if (parameters.get("resume") === "accepted")
  server = { ...server, status: "updating", targetVersion: "0.0.19", phase: "verifying", jobId: "accepted-job" };
(window as unknown as { updateDemo: typeof demo }).updateDemo = demo;
const realNow = Date.now;
Date.now = () => realNow() + demo.clockOffset;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    location.href
  );
  if (demo.offline) throw new Error("Server restarting");
  if (url.pathname === "/api/auth/config") return Response.json({ mode: "required" });
  if (url.pathname === "/api/auth/login") {
    const { username } = JSON.parse(String(init?.body));
    return Response.json({ user: { id: username, username, name: username, email: `${username}@example.invalid`, image: null } },
      { headers: { "set-auth-token": `synthetic-${username}` } });
  }
  if (url.pathname === "/api/auth/get-session") {
    const account = new Headers(init?.headers).get("authorization")?.slice("Bearer synthetic-".length) ?? "A";
    return Response.json({ session: { id: account }, user: { id: account, username: account, name: account, email: `${account}@example.invalid`, image: null } });
  }
  if (url.pathname === "/api/auth/sign-out") return new Response(null, { status: 204 });
  if (url.pathname === "/api/v0/system/version")
    return Response.json({
      releaseVersion: server.currentVersion,
      apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION,
    });
  if (url.pathname === "/api/v0/system/busy-bots") {
    if (demo.holdBusy) {
      demo.holdBusy = false;
      demo.busyHeld = true;
      await new Promise<void>((resolve) => { demo.releaseBusy = resolve; });
    }
    return Response.json({
      bots: demo.busy ? [{ botId: "scout", name: "Scout", runIds: ["demo"] }] : [],
    });
  }
  if (url.pathname === "/api/v0/system/update") {
    if (init?.method === "POST") {
      const { targetVersion } = JSON.parse(String(init.body));
      demo.posts.push(targetVersion);
      demo.events.push("server-start");
      demo.server({
        targetVersion,
        status: "updating",
        phase: "checking",
        message: "Checking the signed release…",
        jobId: "demo-job",
        safeToCloseDesktop: true,
      });
      if (demo.auto)
        void (async () => {
          for (const [phase, message] of [
            ["pulling", "Downloading the server release…"],
            ["backing-up", "Backing up your database…"],
            ["restarting", "Restarting server services…"],
            ["verifying", "Checking server health…"],
          ]) {
            await pause(demo.duration);
            demo.server({ phase, message });
          }
          await pause(demo.duration);
          if (demo.failServer) {
            demo.server({
              status: "error",
              message: "Server health check failed. The previous version was restored.",
            });
            return;
          }
          demo.events.push("server-verified");
          demo.server({
            currentVersion: targetVersion,
            status: "updated",
            phase: "complete",
            message: "Server updated and healthy.",
          });
        })();
    }
    return Response.json(server);
  }
  throw new Error(`Network disabled in demo: ${url.pathname}`);
};
window.openteam = {
  versions: { app: "0.0.18" },
  updates: {
    status: async () => desktop,
    check: async () => {
      if (desktop.status === "error") demo.emit({ status: "available", message: null });
      return desktop;
    },
    onClientProgress(listener: (next: OpenTeamUpdateStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async openDownload(expectedVersion?: string) {
      if (expectedVersion && expectedVersion !== desktop.latestVersion)
        throw new Error("The desktop release changed");
      demo.downloadTargets.push(expectedVersion ?? null);
      demo.downloads++;
      demo.events.push("desktop-download");
      if (demo.failDownload) throw new Error("Desktop download interrupted");
      demo.emit({ status: "downloading", progress: 0, message: "Starting desktop download…" });
      if (demo.hangDownload) return new Promise<void>(() => {});
      if (!demo.auto) return;
      for (const progress of [24, 53, 81, 100]) {
        await pause(demo.duration / 2);
        demo.emit({ progress, message: `Downloading ${progress}%` });
      }
      demo.events.push("desktop-ready");
      demo.emit({ status: "downloaded", message: "Desktop is ready. Restart when you’re ready." });
    },
    async installClient() {
      demo.installs++;
      demo.events.push("desktop-restart");
      demo.emit({ status: "installing" });
    },
  },
} as unknown as NonNullable<Window["openteam"]>;
const [{ default: UpdatesSettings }, { DesktopUpdateDialog }] = await Promise.all([
  import("../../src/renderer/components/openteam/settings/updates"),
  import("../../src/renderer/components/openteam/desktop-update-dialog"),
]);
const auth = await import("../../src/renderer/client/auth");
demo.signIn = async (account) => { await auth.signIn(account, "synthetic-test-password"); };
demo.signOut = auth.signOut;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <style>{`.update-demo-sidebar{display:none}.update-demo-main{max-width:960px;margin:auto;padding:40px 24px}@media(min-width:640px){.update-demo-sidebar{display:block;width:210px}.update-demo-main{margin-left:210px;padding:40px}}`}</style>
    <DesktopUpdateDialog />
    <div className="min-h-screen bg-background text-foreground">
      <aside className="update-demo-sidebar fixed inset-y-0 left-0 border-r bg-sidebar p-5">
        <div className="mb-9 flex items-center gap-2 text-[14px] font-medium">
          <ChevronLeft className="size-4" />
          Settings
        </div>
        <nav className="space-y-1 text-[13px]">
          {[
            { label: "General", icon: SlidersHorizontal },
            { label: "Computer", icon: Monitor },
            { label: "Server", icon: Server },
            { label: "Connections", icon: Radio },
            { label: "Updates", icon: ArrowUpCircle },
          ].map(({ label, icon: Icon }) => (
            <div
              key={label}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 ${label === "Updates" ? "bg-black/[0.07] font-medium dark:bg-white/10" : "text-muted-foreground"}`}
            >
              <Icon className="size-4" />
              {label}
            </div>
          ))}
        </nav>
        <div className="absolute bottom-6 text-[11px] text-muted-foreground">
          Interactive demo · simulated updates
        </div>
      </aside>
      <main className="update-demo-main">
        <h1 className="mb-2 text-[23px] font-semibold tracking-tight">Updates</h1>
        <p className="mb-9 text-[13px] text-muted-foreground">
          Keep your desktop and connected server up to date.
        </p>
        <UpdatesSettings />
      </main>
    </div>
  </StrictMode>
);
demo.ready = true;
