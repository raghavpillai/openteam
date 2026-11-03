import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenSession } from "../src/screen/types";
import { ScreenBroker } from "../src/screen-broker";

describe("graphical screen lifecycle", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home) await rm(home, { force: true, recursive: true });
    home = undefined;
  });

  test("asks for a snapshot only of the profile whose browser a bot used", async () => {
    home = await mkdtemp(join(tmpdir(), "openteam-screen-browser-use-"));
    const broker = new ScreenBroker(home);
    const session = { botId: "nova", profileDirectory: join(home, "chrome-profile-2") } as ScreenSession;
    Object.assign(broker, {
      readySession: async () => session,
      withInput: async (_session: ScreenSession, _actor: string, operation: () => Promise<unknown>) => operation(),
    });
    (broker as unknown as { sessions: Map<string, ScreenSession> }).sessions.set("nova", session);
    expect(broker.takeBrowserUse("nova")).toBeNull();
    await broker.withAgentBrowserInput("nova", "/workspace", async () => undefined);
    expect(broker.takeBrowserUse("nova")).toBe("chrome-profile-2");
    expect(broker.takeBrowserUse("nova")).toBeNull();
  });

  test("does not advertise per-tab state that a restart cannot bring back", () => {
    const broker = new ScreenBroker("/tmp/no-io-needed") as unknown as {
      statusFor(session: Partial<ScreenSession>): { browserStateCoverage: string[] };
    };
    const coverage = broker.statusFor({ botId: "nova", state: "ready", humanTakeoverUntil: 0 }).browserStateCoverage;
    expect(coverage).toContain("local-storage");
    expect(coverage).not.toContain("session-storage");
    expect(coverage).not.toContain("open-tabs");
  });

  test("tombstones destroyed bots so a late inspector poll cannot recreate them", async () => {
    home = await mkdtemp(join(tmpdir(), "openteam-screen-broker-"));
    const mappingPath = join(home, ".sand-window-assignments.json");
    await mkdir(home, { recursive: true });
    await writeFile(mappingPath, `${JSON.stringify({ "archived-bot": 4 })}\n`);

    const broker = new ScreenBroker(home);
    await broker.destroy("archived-bot");

    expect(JSON.parse(await readFile(mappingPath, "utf8"))).toEqual({});
    await expect(broker.status("archived-bot", "/workspace")).rejects.toThrow(
      "Graphical screen was destroyed"
    );
  });

  test("shutdown closes running browsers cleanly and publishes their profiles first", async () => {
    home = await mkdtemp(join(tmpdir(), "openteam-screen-shutdown-"));
    const browser = join(home, "google-chrome");
    // Like Chromium, the fake browser saves extension settings only when it exits cleanly.
    await writeFile(
      browser,
      `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac; done
settings="$profile/Default/Local Extension Settings/extension"
trap 'mkdir -p "$settings" && echo saved-on-exit > "$settings/000003.log"; exit 0' TERM
touch "$profile/started"
while :; do sleep 1 & wait $!; done
`,
      { mode: 0o755 }
    );
    const broker = new ScreenBroker(home);
    Object.assign(broker, {
      startSession: async (session: ScreenSession) => {
        await mkdir(session.profileDirectory, { recursive: true });
        session.state = "ready";
        session.lastHealthCheckAt = Date.now();
      },
      spawnLongLived: (_command: string, args: string[], session: ScreenSession) => {
        const child = spawn(browser, args, { stdio: "ignore" });
        session.processes.push(child);
        return child;
      },
      browserBroker: { attach: async () => undefined, detach: async () => undefined },
    });
    await broker.act("bot", "/workspace", { action: "open_app", app: "chromium" }, "human");
    const started = join(home, "chrome-profile", "started");
    for (let attempt = 0; attempt < 50 && !(await Bun.file(started).exists()); attempt += 1) {
      await Bun.sleep(100);
    }

    await broker.shutdown();

    const published = join(
      home,
      ".openteam/browser-profile-authority/current/profile/Default/Local Extension Settings/extension/000003.log"
    );
    expect(await readFile(published, "utf8")).toBe("saved-on-exit\n");
  });

  test("ships the screenshot executable used by the screen broker", async () => {
    const dockerfile = await Bun.file(
      new URL("../../../docker/computer.Dockerfile", import.meta.url)
    ).text();

    expect(dockerfile).toMatch(/apt-get install[\s\S]*?\bimagemagick\b/);
  });
});
