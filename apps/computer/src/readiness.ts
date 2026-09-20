import { spawn } from "node:child_process";
import { agentProcessIdentity } from "./agent-process";

// ScreenBroker starts these components directly; it does not use xfce4-session.
// Check installed programs, not running processes: screens start on demand.
export const checkDesktopAvailable = (
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => string | null = (command) => Bun.which(command)
): boolean =>
  platform === "linux" &&
  [
    "Xvfb",
    "dbus-daemon",
    "xsetroot",
    "xfsettingsd",
    "xfwm4",
    "xfdesktop",
    "xfce4-panel",
    "x11vnc",
    "/usr/share/novnc/utils/novnc_proxy",
    "xfce4-terminal",
    "google-chrome",
    "xdotool",
    "import",
  ].every((command) => which(command) !== null);

// Verify process launch and workspace access using the intended agent identity.
// Explicitly drop and verify privileges: some runtimes ignore spawn({ uid }).
const SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
let directory;
try {
  const uid = Number(process.argv[2]);
  const gid = Number(process.argv[3]);
  if (process.getuid() === 0) {
    process.setgroups([]);
    process.setgid(gid);
    process.setuid(uid);
  }
  if (process.getuid() !== uid || process.getgid() !== gid) throw Error('Wrong probe identity');
  directory = fs.mkdtempSync(path.join(process.argv[1], '.openteam-health-'));
  const file = path.join(directory, 'probe');
  fs.writeFileSync(file, 'openteam-health', {mode: 0o600});
  if (fs.readFileSync(file, 'utf8') !== 'openteam-health') throw Error('Readback failed');
  fs.unlinkSync(file);
  fs.rmdirSync(directory);
  directory = undefined;
} catch { process.exitCode = 1; }
finally { if (directory) { try { fs.rmSync(directory, {recursive:true, force:true}); } catch {} } }
`;

export const checkAgentWorkspace = (workspace: string, timeoutMs = 2_000): Promise<boolean> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (ready: boolean) => {
      clearTimeout(timer);
      resolve(ready);
    };
    const identity = agentProcessIdentity();
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'exec "$1" -e "$2" "$3" "$4" "$5"',
        "openteam-health",
        process.execPath,
        SCRIPT,
        workspace,
        String(identity.uid ?? process.getuid?.()),
        String(identity.gid ?? process.getgid?.()),
      ],
      {
        ...identity,
        // The probe needs no credentials, inherited shell hooks, or user configuration.
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        cwd: "/tmp",
        stdio: "ignore",
      }
    );
    child.once("error", () => done(false));
    child.once("close", (code) => done(code === 0));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, timeoutMs);
  });

export class ComputerReadiness {
  private inFlight: Promise<boolean> | null = null;
  private cached: { ready: boolean; expiresAt: number } | null = null;
  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly cacheMs = 5_000
  ) {}
  check(): Promise<boolean> {
    if (this.cached && this.cached.expiresAt > Date.now())
      return Promise.resolve(this.cached.ready);
    this.inFlight ??= this.probe()
      .catch(() => false)
      .then((ready) => {
        this.cached = { ready, expiresAt: Date.now() + this.cacheMs };
        return ready;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
