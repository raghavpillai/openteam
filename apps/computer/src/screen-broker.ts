import type { ComputerUseActionInput, ScreenActionInput } from "@openteam/contracts";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chown, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  private allocation: Promise<void> = Promise.resolve();

  constructor(private readonly home = process.env.HOME ?? "/home/box") {
    this.stateRoot = join(home, ".openteam");
    this.mappingPath = join(home, ".sand-window-assignments.json");
    this.browserBroker = new BrowserBroker(home);
    this.profileAuthority = new BrowserProfileAuthority(home);
  }

  async ensure(botId: string, cwd: string): Promise<ScreenStatus> {
    if (this.destroyedBotIds.has(botId)) throw new Error("Graphical screen was destroyed");
    await this.loadMappings();
    if (this.destroyedBotIds.has(botId)) throw new Error("Graphical screen was destroyed");
    let session = this.sessions.get(botId);
    if (!session) {
      const slot = await this.allocateSlot(botId);
      if (this.destroyedBotIds.has(botId)) {
        if (this.slotByBot.delete(botId)) await this.persistMappings();
        throw new Error("Graphical screen was destroyed");
      }
      session = {
        botId,
        cwd,
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
    if (actor === "agent") this.assertAgentControl(session);
    const env = environment(this.home, session);
    switch (input.action) {
      case "move":
        await run("xdotool", ["mousemove", "--sync", String(input.x), String(input.y)], { env });
        break;
      case "click": {
        const button = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
        const args = ["mousemove", "--sync", String(input.x), String(input.y), "click"];
        if (input.double) args.push("--repeat", "2", "--delay", "140");
        args.push(button);
        await run("xdotool", args, { env });
        break;
      }
      case "drag": {
        const button = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
        const [first, ...rest] = input.path;
        if (!first) throw new Error("A drag path needs at least two points");
        await run(
          "xdotool",
          [
            "mousemove",
            "--sync",
            String(first.x),
            String(first.y),
            "mousedown",
            button,
            ...rest.flatMap((point) => ["mousemove", "--sync", String(point.x), String(point.y)]),
            "mouseup",
            button,
          ],
          { env }
        );
        break;
      }
      case "type":
        await run("xdotool", ["type", "--clearmodifiers", "--delay", "2", "--", input.text], {
          env,
        });
        break;
      case "key":
        await run("xdotool", ["key", "--clearmodifiers", ...input.keys], { env });
        break;
      case "scroll": {
        const button = input.deltaY >= 0 ? "5" : "4";
        const repeat = Math.max(1, Math.abs(input.deltaY));
        await run("xdotool", ["click", "--repeat", String(repeat), "--delay", "30", button], {
          env,
        });
        break;
      }
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
        await new Promise((resolve) => setTimeout(resolve, input.app === "chromium" ? 1_500 : 700));
        break;
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, input.ms));
        break;
    }
    return this.statusFor(session);
  }

  async actComputerUse(
    botId: string,
    cwd: string,
    actions: readonly ComputerUseActionInput[]
  ): Promise<Buffer> {
    const session = await this.readySession(botId, cwd);
    this.assertAgentControl(session);
    const env = environment(this.home, session);
    for (const action of actions) {
      this.assertAgentControl(session);
      await performComputerUseAction(action, env);
    }
    const finalAction = actions.at(-1)?.action;
    if (finalAction && finalAction !== "wait" && finalAction !== "screenshot") {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return run("import", ["-display", `:${session.display}`, "-window", "root", "png:-"], {
      env,
      captureStdout: true,
    });
  }

  async commandEnvironment(botId: string, cwd: string): Promise<NodeJS.ProcessEnv> {
    const session = await this.readySession(botId, cwd);
    return environment(this.home, session);
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
    return this.statusFor(session);
  }

  async pauseAgent(botId: string, cwd: string, paused: boolean): Promise<ScreenStatus> {
    const session = await this.readySession(botId, cwd);
    session.agentInputPaused = paused;
    return this.statusFor(session);
  }

  async destroy(botId: string): Promise<void> {
    this.destroyedBotIds.add(botId);
    await this.loadMappings();
    const session = this.sessions.get(botId);
    if (session) {
      session.destroyed = true;
      session.state = "failed";
      await this.browserBroker.detach(botId);
      await stopProcesses(session);
      await this.profileAuthority.publish(session.profileDirectory);
      await session.startPromise?.catch(() => undefined);
      this.sessions.delete(botId);
      await rm(session.runtimeDirectory, { recursive: true, force: true });
    }
    if (this.slotByBot.delete(botId)) await this.persistMappings();
  }

  private async readySession(botId: string, cwd: string): Promise<ScreenSession> {
    await this.ensure(botId, cwd);
    const session = this.sessions.get(botId);
    if (!session || session.state !== "ready") {
      throw new Error(session?.error ?? "Graphical screen is unavailable");
    }
    return session;
  }

  private assertAgentControl(session: ScreenSession): void {
    if (session.agentInputPaused) throw new Error("Agent graphical input is paused");
    if (session.humanTakeoverUntil > Date.now()) {
      throw new Error("The user currently holds the graphical input lease");
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
      this.assertNotDestroyed(session);
      const display = `:${session.display}`;
      const xvfb = this.spawnLongLived(
        "Xvfb",
        [display, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-nolisten", "tcp", "-ac"],
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
      width: WIDTH,
      height: HEIGHT,
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
    this.allocation = this.allocation.then(async () => {
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
    await this.allocation;
    return allocated;
  }

  private async persistMappings(): Promise<void> {
    await writeFile(
      this.mappingPath,
      `${JSON.stringify(Object.fromEntries(this.slotByBot), null, 2)}\n`,
      { mode: 0o600 }
    );
  }
}

export { type ScreenStatus } from "./screen/types";
