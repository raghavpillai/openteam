import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chown, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerUseActionInput, ScreenActionInput } from "@openteam/contracts";
import { agentProcessIdentity } from "./agent-process";
import { BrowserBroker } from "./browser/broker";
import { BrowserProfileAuthority } from "./browser/profile-authority";
import { performComputerUseAction } from "./screen/actions";
import {
  environment,
  exists,
  failSession,
  processHasExited,
  refreshSessionHealth,
  removeProcess,
  run,
  stopProcesses,
  tcpPortAccepts,
  viewerHttpResponds,
} from "./screen/processes";
import type { ScreenSession, ScreenStatus } from "./screen/types";

const WIDTH = 1280;

const HEIGHT = 800;

const MAX_SCREENS = 100;

const DISPLAY_BASE = 100;

const RFB_PORT_BASE = 5900;

const VIEWER_PORT_BASE = 6200;

const BROWSER_DEBUG_PORT_BASE = 9300;

const TAKEOVER_TTL_MS = 45_000;

const ENDPOINT_STARTUP_TIMEOUT_MS = 10_000;

const DESKTOP_CONFIG_ROOT = "/usr/share/openteam-desktop/config";

// Classic VNC authentication uses only the first eight password characters.
// Six random bytes encode to eight base64url characters, preserving all 48 bits.
export const createViewerPassword = (): string => randomBytes(6).toString("base64url");

export class ScreenBroker {
  private readonly sessions = new Map<string, ScreenSession>();
  private readonly slotByBot = new Map<string, number>();
  private readonly destroyedBotIds = new Set<string>();
  private readonly stateRoot: string;
  private readonly mappingPath: string;
  private readonly browserBroker: BrowserBroker;
  private readonly profileAuthority: BrowserProfileAuthority;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private allocation: Promise<void> = Promise.resolve();
  private mappingWrites: Promise<void> = Promise.resolve();
  private readonly inputQueues = new WeakMap<ScreenSession, Promise<void>>();
  private readonly inputRevisions = new WeakMap<ScreenSession, number>();
  private readonly activeAgentInput = new WeakMap<ScreenSession, AbortController>();
  private readonly readySessions = new Map<string, Promise<ScreenSession>>();

  constructor(private readonly home = process.env.HOME ?? "/home/box", private readonly displayDimensions:()=>Promise<{width:number;height:number}> = async()=>({width:WIDTH,height:HEIGHT})) {
    this.stateRoot = join(home, ".openteam");
    this.mappingPath = join(home, ".sand-window-assignments.json");
    this.browserBroker = new BrowserBroker(home);
    this.profileAuthority = new BrowserProfileAuthority(home);
  }

  async ensure(botId: string, cwd: string): Promise<ScreenStatus> {
    if (this.destroyedBotIds.has(botId)) throw new Error("Graphical screen was destroyed");
    await this.loadMappings();
    if (this.destroyedBotIds.has(botId)) throw new Error("Graphical screen was destroyed");
    const dimensions = await this.displayDimensions();
    let session = this.sessions.get(botId);
    if (!session) {
      const slot = await this.allocateSlot(botId);
      if (this.destroyedBotIds.has(botId)) {
        if (this.slotByBot.delete(botId)) await this.persistMappings();
        throw new Error("Graphical screen was destroyed");
      }
      // Another request may have created this session while slot allocation waited.
      session = this.sessions.get(botId);
      if (!session) {
        session = {
          botId,
          cwd,
          width:dimensions.width,
          height:dimensions.height,
          slot,
          display: DISPLAY_BASE + slot,
          rfbPort: RFB_PORT_BASE + slot,
          viewerPort: VIEWER_PORT_BASE + slot,
          viewerPassword: createViewerPassword(),
          browserDebugPort: BROWSER_DEBUG_PORT_BASE + slot,
          profileDirectory:
            slot === 0
              ? join(this.home, "chrome-profile")
              : join(this.home, `chrome-profile-${slot + 1}`),
          runtimeDirectory: join("/tmp", `openteam-screen-${slot}`),
          state: "starting",
          error: null,
          humanTakeoverUntil: 0,
          agentInputPaused: false,
          destroyed: false,
          stopping: false,
          processes: [],
          browserProcess: null,
          startPromise: null,
          lastHealthCheckAt: 0,
          healthCheckPromise: null,
        };
        this.sessions.set(botId, session);
      }
    } else {
      session.cwd = cwd;
    }
    if (session.state === "ready") await refreshSessionHealth(session);
    if (!session.startPromise && session.state !== "ready") {
      session.startPromise = this.startSession(session).finally(() => {
        session!.startPromise = null;
      });
    }
    await session.startPromise;
    return this.statusFor(session);
  }

  async status(botId: string, cwd: string): Promise<ScreenStatus> {
    return this.ensure(botId, cwd);
  }

  async screenshot(botId: string, cwd: string): Promise<Buffer> {
    const session = await this.readySession(botId, cwd);
    return run("import", ["-display", `:${session.display}`, "-window", "root", "png:-"], {
      env: environment(this.home, session),
      captureStdout: true,
    });
  }

  async act(
    botId: string,
    cwd: string,
    input: ScreenActionInput,
    actor: "agent" | "human"
  ): Promise<ScreenStatus> {
    const session = await this.readySession(botId, cwd);
    return this.withInput(session, actor, async (signal) => {
      const env = environment(this.home, session);
      switch (input.action) {
        case "move":
        case "drag":
        case "type":
          await performComputerUseAction(input, env, signal);
          break;
        case "click":
          await performComputerUseAction({ ...input, count: input.double ? 2 : 1 }, env, signal);
          break;
        case "key":
          for (const key of input.keys) {
            signal?.throwIfAborted();
            await performComputerUseAction({ action: "key", key }, env, signal);
          }
          break;
        case "scroll":
          await performComputerUseAction(
            {
              action: "scroll",
              direction: input.deltaY >= 0 ? "down" : "up",
              amount: Math.max(1, Math.abs(input.deltaY)),
            },
            env,
            signal
          );
          break;
        case "open_app":
          this.openApp(session, input.app);
          if (input.app === "chromium") {
            await this.browserBroker.attach(
              session.botId,
              session.browserDebugPort,
              session.profileDirectory,
              60
            );
          }
          await new Promise((resolve) =>
            setTimeout(resolve, input.app === "chromium" ? 1_500 : 700)
          );
          break;
        case "wait":
          await performComputerUseAction({ action: "wait", durationMs: input.ms }, env, signal);
          break;
      }
      return this.statusFor(session);
    });
  }

  async actComputerUse(
    botId: string,
    cwd: string,
    actions: readonly ComputerUseActionInput[]
  ): Promise<Buffer> {
    const session = await this.readySession(botId, cwd);
    return this.withInput(session, "agent", async (signal) => {
      const env = environment(this.home, session);
      for (const action of actions) {
        signal?.throwIfAborted();
        this.assertAgentControl(session);
        await performComputerUseAction(action, env, signal);
      }
      const finalAction = actions.at(-1)?.action;
      if (finalAction && finalAction !== "wait" && finalAction !== "screenshot") {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return run("import", ["-display", `:${session.display}`, "-window", "root", "png:-"], {
        env,
        captureStdout: true,
        signal,
      });
    });
  }

  async commandEnvironment(botId: string, cwd: string): Promise<NodeJS.ProcessEnv> {
    const session = await this.readySession(botId, cwd);
    return environment(this.home, session);
  }

  async withAgentBrowserInput<T>(botId: string, cwd: string, operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    return this.withInput(await this.readySession(botId, cwd), "agent", operation);
  }

  async browserEndpointForAgent(botId: string, cwd: string): Promise<string> {
    const session = await this.readySession(botId, cwd);
    this.assertAgentControl(session);
    const endpoint = `http://127.0.0.1:${session.browserDebugPort}`;
    if (!(await this.browserIsReady(endpoint))) this.openApp(session, "chromium");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await this.browserIsReady(endpoint)) {
        await this.browserBroker.attach(
          session.botId,
          session.browserDebugPort,
          session.profileDirectory,
          60
        );
        return endpoint;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Chromium did not expose its page-control endpoint");
  }

  async takeover(botId: string, cwd: string, active: boolean): Promise<ScreenStatus> {
    const session = await this.readySession(botId, cwd);
    session.humanTakeoverUntil = active ? Date.now() + TAKEOVER_TTL_MS : 0;
    if (active) await this.interruptAgentInput(session);
    return this.statusFor(session);
  }

  async pauseAgent(botId: string, cwd: string, paused: boolean): Promise<ScreenStatus> {
    const session = await this.readySession(botId, cwd);
    session.agentInputPaused = paused;
    if (paused) await this.interruptAgentInput(session);
    return this.statusFor(session);
  }

  async destroy(botId: string): Promise<void> {
    this.destroyedBotIds.add(botId);
    await this.loadMappings();
    const session = this.sessions.get(botId);
    if (session) {
      session.destroyed = true;
      session.state = "failed";
      await this.interruptAgentInput(session);
      await this.inputQueues.get(session);
      await this.browserBroker.detach(botId);
      await stopProcesses(session);
      await this.profileAuthority.publish(session.profileDirectory);
      await session.startPromise?.catch(() => undefined);
      this.sessions.delete(botId);
      await rm(session.runtimeDirectory, { recursive: true, force: true });
    }
    if (this.slotByBot.delete(botId)) await this.persistMappings();
  }

  private readySession(botId: string, cwd: string): Promise<ScreenSession> {
    // Concurrent inputs must cross the same readiness barrier in arrival order.
    // Separate health probes can finish out of order before withInput queues them.
    const existing = this.readySessions.get(botId);
    if (existing) return existing;
    const pending = this.ensure(botId, cwd).then(() => {
      const session = this.sessions.get(botId);
      if (!session || session.state !== "ready") {
        throw new Error(session?.error ?? "Graphical screen is unavailable");
      }
      return session;
    });
    this.readySessions.set(botId, pending);
    const clear = () => {
      if (this.readySessions.get(botId) === pending) this.readySessions.delete(botId);
    };
    void pending.then(clear, clear);
    return pending;
  }

  private assertAgentControl(session: ScreenSession): void {
    if (session.agentInputPaused) throw new Error("Agent graphical input is paused");
    if (session.humanTakeoverUntil > Date.now()) {
      throw new Error("The user currently holds the graphical input lease");
    }
  }

  private withInput<T>(
    session: ScreenSession,
    actor: "agent" | "human",
    operation: (signal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    const revision = this.inputRevisions.get(session) ?? 0;
    const result = (this.inputQueues.get(session) ?? Promise.resolve()).then(async () => {
      this.assertNotDestroyed(session);
      let controller: AbortController | undefined;
      if (actor === "agent") {
        this.assertAgentControl(session);
        if (revision !== (this.inputRevisions.get(session) ?? 0)) {
          throw new Error("Graphical control changed; inspect the screen before retrying input");
        }
        controller = new AbortController();
        this.activeAgentInput.set(session, controller);
      }
      try {
        return await operation(controller?.signal);
      } finally {
        if (controller) this.activeAgentInput.delete(session);
      }
    });
    this.inputQueues.set(
      session,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }

  private async interruptAgentInput(session: ScreenSession): Promise<void> {
    this.inputRevisions.set(session, (this.inputRevisions.get(session) ?? 0) + 1);
    const controller = this.activeAgentInput.get(session);
    if (controller) {
      controller.abort(new Error("Agent graphical input interrupted by a control change"));
      await this.inputQueues.get(session);
    }
  }

  private async browserIsReady(endpoint: string): Promise<boolean> {
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(250),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async startSession(session: ScreenSession): Promise<void> {
    this.assertNotDestroyed(session);
    session.state = "starting";
    session.error = null;
    this.assertNotDestroyed(session);
    const stoppedOwnedBrowser = Boolean(
      session.browserProcess && session.browserProcess.exitCode === null
    );
    await this.browserBroker.detach(session.botId);
    await stopProcesses(session);
    try {
      await this.prepareAgentDirectory(session.profileDirectory, 0o770);
      if (stoppedOwnedBrowser) await this.profileAuthority.publish(session.profileDirectory);
      else await this.profileAuthority.seedIfEmpty(session.profileDirectory);
      await this.profileAuthority.prepare(session.profileDirectory);
      // Chromium's profile survives container restarts, but its process-singleton
      // markers do not. Clear only those ephemeral locks before recreating the
      // bot's desktop; history, cookies, and the rest of the profile stay durable.
      await Promise.all(
        ["SingletonCookie", "SingletonLock", "SingletonSocket"].map((entry) =>
          rm(join(session.profileDirectory, entry), { force: true, recursive: true })
        )
      );
      this.assertNotDestroyed(session);
      await rm(session.runtimeDirectory, { recursive: true, force: true });
      await this.prepareAgentDirectory(session.runtimeDirectory, 0o700);
      session.viewerPassword = createViewerPassword();
      const viewerPasswordPath = join(session.runtimeDirectory, "viewer-password");
      await writeFile(viewerPasswordPath, `${session.viewerPassword}\n`, { mode: 0o600 });
      await cp(DESKTOP_CONFIG_ROOT, join(session.runtimeDirectory, "config"), {
        recursive: true,
      });
      await mkdir(join(session.runtimeDirectory, "cache"), { recursive: true });
      await mkdir(join(session.runtimeDirectory, "data"), { recursive: true });
      // Concurrent Xvfb processes race when creating their shared socket directory.
      await mkdir("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
      this.assertNotDestroyed(session);
      const display = `:${session.display}`;
      const xvfb = this.spawnLongLived(
        "Xvfb",
        [display, "-screen", "0", `${session.width ?? WIDTH}x${session.height ?? HEIGHT}x24`, "-nolisten", "tcp", "-ac"],
        session,
        environment(this.home, session),
        "/workspace",
        true
      );
      await this.waitForEndpoint(
        () => exists(`/tmp/.X11-unix/X${session.display}`),
        `Virtual display :${session.display}`,
        session,
        xvfb
      );
      this.assertNotDestroyed(session);
      const env = environment(this.home, session);
      const dbus = this.spawnLongLived(
        "dbus-daemon",
        [
          "--session",
          `--address=unix:path=${join(session.runtimeDirectory, "bus")}`,
          "--nofork",
          "--nopidfile",
        ],
        session,
        env,
        "/workspace",
        true
      );
      await this.waitForEndpoint(
        () => exists(join(session.runtimeDirectory, "bus")),
        "D-Bus session bus",
        session,
        dbus
      );
      this.assertNotDestroyed(session);
      await run("xsetroot", ["-solid", "#242629"], { env });
      // xfconf is D-Bus activated on Debian; xfconfd intentionally lives outside PATH.
      this.spawnLongLived("xfsettingsd", ["--replace"], session, env, "/workspace", true);
      this.spawnLongLived(
        "xfwm4",
        ["--replace", "--compositor=on"],
        session,
        env,
        "/workspace",
        true
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      this.assertNotDestroyed(session);
      this.spawnLongLived("xfdesktop", ["--disable-wm-check"], session, env, "/workspace", true);
      this.spawnLongLived("xfce4-panel", ["--disable-wm-check"], session, env, "/workspace", true);
      const vnc = this.spawnLongLived(
        "x11vnc",
        [
          "-display",
          display,
          "-rfbport",
          String(session.rfbPort),
          "-localhost",
          "-forever",
          "-shared",
          "-passwdfile",
          `rm:${viewerPasswordPath}`,
          "-noxdamage",
          "-repeat",
          "-quiet",
        ],
        session,
        env,
        "/workspace",
        true
      );
      const viewer = this.spawnLongLived(
        "/usr/share/novnc/utils/novnc_proxy",
        ["--listen", `0.0.0.0:${session.viewerPort}`, "--vnc", `127.0.0.1:${session.rfbPort}`],
        session,
        env,
        "/workspace",
        true
      );
      await Promise.all([
        this.waitForEndpoint(() => tcpPortAccepts(session.rfbPort), "VNC server", session, vnc),
        this.waitForEndpoint(
          () => viewerHttpResponds(session.viewerPort),
          "noVNC viewer",
          session,
          viewer
        ),
      ]);
      this.assertSessionStarting(session);
      this.openApp(session, "terminal");
      session.lastHealthCheckAt = Date.now();
      session.state = "ready";
    } catch (error) {
      session.state = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      await stopProcesses(session);
      throw error;
    }
  }

  private assertNotDestroyed(session: ScreenSession): void {
    if (session.destroyed || this.destroyedBotIds.has(session.botId)) {
      throw new Error("Graphical screen was destroyed");
    }
  }

  private assertSessionStarting(session: ScreenSession): void {
    this.assertNotDestroyed(session);
    if (session.state === "failed") {
      throw new Error(session.error ?? "Graphical screen failed while starting");
    }
  }

  private openApp(session: ScreenSession, app: "chromium" | "thunar" | "terminal"): ChildProcess {
    const env = environment(this.home, session);
    if (app === "chromium") {
      if (session.browserProcess && session.browserProcess.exitCode === null) {
        return session.browserProcess;
      }
      const child = this.spawnLongLived(
        "google-chrome",
        [
          "--no-sandbox",
          "--test-type",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--disable-default-apps",
          "--password-store=basic",
          "--hide-crash-restore-bubble",
          "--disable-features=Translate",
          `--user-data-dir=${session.profileDirectory}`,
          "--remote-debugging-address=127.0.0.1",
          "--remote-allow-origins=*",
          `--remote-debugging-port=${session.browserDebugPort}`,
          "--new-window",
          "about:blank",
        ],
        session,
        env
      );
      session.browserProcess = child;
      child.once("exit", () => {
        if (session.browserProcess === child) session.browserProcess = null;
        void this.browserBroker
          .detach(session.botId)
          .then(() => this.profileAuthority.publish(session.profileDirectory));
      });
      void this.browserBroker.attach(
        session.botId,
        session.browserDebugPort,
        session.profileDirectory,
        60
      );
      return child;
    }
    if (app === "thunar") {
      return this.spawnLongLived("thunar", [session.cwd], session, env);
    }
    return this.spawnLongLived("xfce4-terminal", ["--disable-server"], session, env, session.cwd);
  }

  private spawnLongLived(
    command: string,
    args: string[],
    session: ScreenSession,
    env = environment(this.home, session),
    cwd = "/workspace",
    critical = false
  ): ChildProcess {
    const child = spawn(command, args, {
      cwd,
      env,
      ...agentProcessIdentity(),
      stdio: "ignore",
    });
    session.processes.push(child);
    child.once("error", (error) => {
      const tracked = removeProcess(session, child);
      if (critical && tracked) {
        failSession(session, `${command} failed to start: ${error.message}`);
      }
    });
    child.once("exit", () => {
      const tracked = removeProcess(session, child);
      if (critical && tracked) failSession(session, `${command} exited unexpectedly`);
    });
    return child;
  }

  private async prepareAgentDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
    const identity = agentProcessIdentity();
    if (identity.uid !== undefined && identity.gid !== undefined) {
      await chown(path, identity.uid, identity.gid);
    }
  }

  private async waitForEndpoint(
    probe: () => Promise<boolean>,
    label: string,
    session: ScreenSession,
    process: ChildProcess
  ): Promise<void> {
    const deadline = Date.now() + ENDPOINT_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.assertNotDestroyed(session);
      if (session.state === "failed") throw new Error(session.error ?? `${label} failed to start`);
      if (processHasExited(process)) throw new Error(`${label} exited before becoming ready`);
      if (await probe()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${label} did not become ready`);
  }

  private statusFor(session: ScreenSession): ScreenStatus {
    return {
      botId: session.botId,
      state: session.state,
      width: session.width ?? WIDTH,
      height: session.height ?? HEIGHT,
      display: session.display,
      viewerPort: session.viewerPort,
      viewerPassword: session.viewerPassword,
      humanTakeover: session.humanTakeoverUntil > Date.now(),
      agentInputPaused: session.agentInputPaused,
      apps: ["chromium", "thunar", "terminal"],
      browserProfileScope: "computer",
      browserSessionScope: "computer",
      browserSessionMechanism: "shared-profiles",
      browserStateCoverage: [
        "cookies",
        "local-storage",
        "session-storage",
        "indexed-db",
        "service-workers",
        "cache-storage",
        "extensions",
        "saved-passwords",
        "client-certificates",
        "settings",
        "bookmarks",
        "history",
        "open-tabs",
      ],
      browserTargetRouting: "bot-owned-tabs",
      error: session.error,
    };
  }

  private async loadMappings(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.readMappings().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  private async readMappings(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.mappingPath, "utf8")) as Record<string, number>;
      for (const [botId, slot] of Object.entries(parsed)) {
        if (Number.isInteger(slot) && slot >= 0 && slot < MAX_SCREENS) {
          this.slotByBot.set(botId, slot);
        }
      }
    } catch {
      // The first run has no mapping. Corrupt mappings are rebuilt as screens are requested.
    }
    this.loaded = true;
  }

  private async allocateSlot(botId: string): Promise<number> {
    const existing = this.slotByBot.get(botId);
    if (existing !== undefined) return existing;
    let allocated = -1;
    const allocation = this.allocation.then(async () => {
      const reserved = this.slotByBot.get(botId);
      if (reserved !== undefined) {
        allocated = reserved;
        return;
      }
      const used = new Set(this.slotByBot.values());
      for (let slot = 0; slot < MAX_SCREENS; slot += 1) {
        if (!used.has(slot)) {
          allocated = slot;
          this.slotByBot.set(botId, slot);
          break;
        }
      }
      if (allocated < 0) throw new Error(`OpenTeam supports at most ${MAX_SCREENS} live screens`);
      await this.persistMappings();
    });
    this.allocation = allocation.catch(() => undefined);
    await allocation;
    return allocated;
  }

  private async persistMappings(): Promise<void> {
    const persist = this.mappingWrites.then(async () => {
      const temporary = `${this.mappingPath}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify(Object.fromEntries(this.slotByBot), null, 2)}\n`,
          {
            mode: 0o600,
          }
        );
        await rename(temporary, this.mappingPath);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.mappingWrites = persist.catch(() => undefined);
    await persist;
  }
}

export type { ScreenStatus } from "./screen/types";
