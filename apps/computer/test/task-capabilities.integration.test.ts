import { expect, test } from "bun:test";

// Run against a built computer image with scripts/test-computer-image.sh IMAGE.
// This exercises the packaged gateway and binaries, rather than a mocked capability.
const gateway = process.env.OPENTEAM_COMPUTER_TEST_URL;

test.skipIf(!gateway)(
  "the packaged computer advertises its desktop to Task workers",
  async () => {
    const deadline = Date.now() + 30_000;
    let response: Response | undefined;
    while (!response) {
      try {
        response = await fetch(new URL("/v1/task-capabilities", gateway), {
          headers: { authorization: `Bearer ${process.env.OPENTEAM_CONTROL_TOKEN}` },
          signal: AbortSignal.timeout(2_000),
        });
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(100);
      }
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ boxAvailable: true, desktopAvailable: true });
  },
  35_000
);

test.skipIf(!gateway)(
  "the agent identity can run the packaged 1Password CLI with its own config directory",
  async () => {
    const { spawnSync } = await import("node:child_process");
    const { statSync } = await import("node:fs");
    const config = statSync("/home/box/.config/op");
    expect(config.uid).toBe(1001);
    expect(config.mode & 0o777).toBe(0o700);
    const run = (args: string[]) =>
      spawnSync("op", args, {
        uid: 1001,
        gid: 1000,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: "/home/box", OP_SERVICE_ACCOUNT_TOKEN: "ops_invalid-test-token" },
      });
    const version = run(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("2.40.0");
    // No network here: whoami must fail on the token, never on the config directory.
    const whoami = run(["whoami"]);
    expect(whoami.status).not.toBe(0);
    expect(whoami.stderr).not.toMatch(/not owned by the current user|permission denied/i);
  },
  35_000
);
