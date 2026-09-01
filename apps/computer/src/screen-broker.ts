import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerUseActionInput, ScreenActionInput } from "@openbot/contracts";
import { BrowserBroker } from "./browser-broker";
import { BrowserProfileAuthority } from "./browser-profile-authority";

const WIDTH = 1280;
const HEIGHT = 800;
const MAX_SCREENS = 100;
const DISPLAY_BASE = 100;
const RFB_PORT_BASE = 5900;
const VIEWER_PORT_BASE = 6200;
const BROWSER_DEBUG_PORT_BASE = 9300;
const TAKEOVER_TTL_MS = 45_000;
const DESKTOP_CONFIG_ROOT = "/usr/share/openbot-desktop/config";

type ScreenState = "starting" | "ready" | "failed";

interface ScreenSession {
  botId: string;
  cwd: string;
  slot: number;
  display: number;
  rfbPort: number;
  viewerPort: number;
  viewerPassword: string;
  browserDebugPort: number;
  profileDirectory: string;
  runtimeDirectory: string;
  state: ScreenState;
  error: string | null;
  humanTakeoverUntil: number;
  agentInputPaused: boolean;
  destroyed: boolean;
  processes: ChildProcess[];
  browserProcess: ChildProcess | null;
  startPromise: Promise<void> | null;
}

export interface ScreenStatus {
  botId: string;
  state: ScreenState;
  width: number;
  height: number;
  display: number;
  viewerPort: number;
  viewerPassword: string;
  humanTakeover: boolean;
  agentInputPaused: boolean;
  apps: Array<"chromium" | "thunar" | "terminal">;
  browserProfileScope: "computer";
  browserSessionScope: "computer";
  browserSessionMechanism: "shared-profiles";
  browserStateCoverage: Array<
    | "cookies"
    | "local-storage"
    | "session-storage"
    | "indexed-db"
    | "service-workers"
    | "cache-storage"
    | "extensions"
    | "saved-passwords"
    | "client-certificates"
    | "settings"
    | "bookmarks"
    | "history"
    | "open-tabs"
  >;
  browserTargetRouting: "bot-owned-tabs";
  error: string | null;
}

const processError = (command: string, stderr: string, code: number | null) =>
  new Error(`${command} exited ${code ?? "without a code"}${stderr ? `: ${stderr.trim()}` : ""}`);

// Classic VNC authentication uses only the first eight password characters.
// Six random bytes encode to eight base64url characters, preserving all 48 bits.
export const createViewerPassword = (): string => randomBytes(6).toString("base64url");

const run = async (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; captureStdout?: boolean } = {}
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(options.captureStdout ? Buffer.concat(stdout) : Buffer.alloc(0));
      else reject(processError(command, stderr, code));
    });
  });

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

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
    this.stateRoot = join(home, ".openbot");
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
        runtimeDirectory: join("/tmp", `openbot-screen-${slot}`),
        state: "starting",
        error: null,
        humanTakeoverUntil: 0,
        agentInputPaused: false,
        destroyed: false,
        processes: [],
        browserProcess: null,
        startPromise: null,
      };
      this.sessions.set(botId, session);
    } else {
      session.cwd = cwd;
    }
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
      env: this.environment(session),
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
    const env = this.environment(session);
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
    const env = this.environment(session);
    for (const action of actions) {
      this.assertAgentControl(session);
      await this.performComputerUseAction(action, env);
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
    return this.environment(session);
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
      await this.stopProcesses(session);
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

  private async performComputerUseAction(
    input: ComputerUseActionInput,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    const button = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
    const modifiers = input.modifiers?.split("+") ?? [];
    const held = modifiers.flatMap((modifier) => ["keydown", modifier]);
    const released = [...modifiers].reverse().flatMap((modifier) => ["keyup", modifier]);
    const position =
      input.x === undefined || input.y === undefined
        ? []
        : ["mousemove", "--sync", String(input.x), String(input.y)];
    switch (input.action) {
      case "screenshot":
        return;
      case "move":
        if (position.length > 0) await run("xdotool", position, { env });
        return;
      case "click":
        await run(
          "xdotool",
          [
            ...position,
            ...held,
            "click",
            "--repeat",
            String(input.count ?? 1),
            "--delay",
            "140",
            button,
            ...released,
          ],
          { env }
        );
        return;
      case "drag": {
        const points = input.path?.length
          ? [...input.path]
          : [
              { x: input.x!, y: input.y! },
              { x: input.x2!, y: input.y2! },
            ];
        const first = points[0]!;
        const path = points
          .slice(1)
          .flatMap((point) => ["mousemove", "--sync", String(point.x), String(point.y)]);
        await run(
          "xdotool",
          [
            "mousemove",
            "--sync",
            String(first.x),
            String(first.y),
            ...held,
            "mousedown",
            button,
            ...path,
            "mouseup",
            button,
            ...released,
          ],
          { env }
        );
        return;
      }
      case "type":
        await run("xdotool", ["type", "--clearmodifiers", "--delay", "2", "--", input.text!], {
          env,
        });
        return;
      case "key":
        await run("xdotool", ["key", "--clearmodifiers", input.key!], { env });
        return;
      case "scroll": {
        const scrollButton = { up: "4", down: "5", left: "6", right: "7" }[input.direction!];
        await run(
          "xdotool",
          [
            ...position,
            ...held,
            "click",
            "--repeat",
            String(input.amount ?? 3),
            "--delay",
            "30",
            scrollButton,
            ...released,
          ],
          { env }
        );
        return;
      }
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, input.durationMs!));
        return;
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
    await this.stopProcesses(session);
    try {
      await mkdir(session.profileDirectory, { recursive: true });
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
      await mkdir(session.runtimeDirectory, { recursive: true, mode: 0o700 });
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
        session
      );
      xvfb.once("exit", () => {
        if (session.state === "ready") {
          session.state = "failed";
          session.error = "The virtual display exited";
        }
      });
      await this.waitForDisplay(session.display);
      this.assertNotDestroyed(session);
      const env = this.environment(session);
      this.spawnLongLived(
        "dbus-daemon",
        [
          "--session",
          `--address=unix:path=${join(session.runtimeDirectory, "bus")}`,
          "--nofork",
          "--nopidfile",
        ],
        session,
        env
      );
      await this.waitForPath(join(session.runtimeDirectory, "bus"), "D-Bus session bus");
      this.assertNotDestroyed(session);
      await run("xsetroot", ["-solid", "#242629"], { env });
      // xfconf is D-Bus activated on Debian; xfconfd intentionally lives outside PATH.
      this.spawnLongLived("xfsettingsd", ["--replace"], session, env);
      this.spawnLongLived("xfwm4", ["--replace", "--compositor=on"], session, env);
      await new Promise((resolve) => setTimeout(resolve, 350));
      this.assertNotDestroyed(session);
      this.spawnLongLived("xfdesktop", ["--disable-wm-check"], session, env);
      this.spawnLongLived("xfce4-panel", ["--disable-wm-check"], session, env);
      this.spawnLongLived(
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
        env
      );
      this.spawnLongLived(
        "/usr/share/novnc/utils/novnc_proxy",
        ["--listen", `0.0.0.0:${session.viewerPort}`, "--vnc", `127.0.0.1:${session.rfbPort}`],
        session,
        env
      );
      await new Promise((resolve) => setTimeout(resolve, 450));
      this.assertNotDestroyed(session);
      this.openApp(session, "terminal");
      session.state = "ready";
    } catch (error) {
      session.state = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      for (const process of session.processes) process.kill("SIGTERM");
      session.processes = [];
      throw error;
    }
  }

  private assertNotDestroyed(session: ScreenSession): void {
    if (session.destroyed || this.destroyedBotIds.has(session.botId)) {
      throw new Error("Graphical screen was destroyed");
    }
  }

  private openApp(session: ScreenSession, app: "chromium" | "thunar" | "terminal"): ChildProcess {
    const env = this.environment(session);
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
    env = this.environment(session),
    cwd = "/workspace"
  ): ChildProcess {
    const child = spawn(command, args, { cwd, env, stdio: "ignore" });
    session.processes.push(child);
    child.once("exit", () => {
      const index = session.processes.indexOf(child);
      if (index >= 0) session.processes.splice(index, 1);
    });
    return child;
  }

  private async stopProcesses(session: ScreenSession): Promise<void> {
    const processes = [...session.processes];
    if (processes.length === 0) {
      session.browserProcess = null;
      return;
    }
    for (const process of processes) process.kill("SIGTERM");
    await Promise.race([
      Promise.all(
        processes.map(
          (process) =>
            new Promise<void>((resolve) => {
              if (process.exitCode !== null) resolve();
              else process.once("exit", () => resolve());
            })
        )
      ),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    for (const process of processes) {
      if (process.exitCode === null) process.kill("SIGKILL");
    }
    session.processes = [];
    session.browserProcess = null;
  }

  private environment(session: ScreenSession): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    delete environment.OPENBOT_CONTROL_TOKEN;
    delete environment.OPENAI_API_KEY;
    delete environment.DATABASE_URL;
    return {
      ...environment,
      HOME: this.home,
      DISPLAY: `:${session.display}`,
      XDG_RUNTIME_DIR: session.runtimeDirectory,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(session.runtimeDirectory, "bus")}`,
      XDG_CONFIG_HOME: join(session.runtimeDirectory, "config"),
      XDG_CACHE_HOME: join(session.runtimeDirectory, "cache"),
      XDG_DATA_HOME: join(session.runtimeDirectory, "data"),
      XDG_CURRENT_DESKTOP: "XFCE",
      XDG_SESSION_DESKTOP: "xfce",
      DESKTOP_SESSION: "xfce",
      XDG_SESSION_TYPE: "x11",
      GDK_BACKEND: "x11",
      GTK_THEME: "Adwaita",
      OPENBOT_SCREEN_CWD: session.cwd,
      OPENBOT_BROWSER_PROFILE: session.profileDirectory,
      OPENBOT_BROWSER_DEBUG_PORT: String(session.browserDebugPort),
    };
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

  private async waitForDisplay(display: number): Promise<void> {
    await this.waitForPath(`/tmp/.X11-unix/X${display}`, `Virtual display :${display}`);
  }

  private async waitForPath(path: string, label: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await exists(path)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`${label} did not become ready`);
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
      if (allocated < 0) throw new Error(`OpenBot supports at most ${MAX_SCREENS} live screens`);
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
