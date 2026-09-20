import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkAgentWorkspace, checkDesktopAvailable, ComputerReadiness } from "../src/readiness";

test("recognizes a component-based desktop without the unused XFCE session manager", () => {
  expect(
    checkDesktopAvailable("linux", (command) => (command === "xfce4-session" ? null : command))
  ).toBe(true);
});

test.each([
  "Xvfb",
  "xfwm4",
  "google-chrome",
  "xdotool",
  "/usr/share/novnc/utils/novnc_proxy",
])("does not advertise desktop control when %s is missing", (missing) => {
  expect(checkDesktopAvailable("linux", (command) => (command === missing ? null : command))).toBe(
    false
  );
});

test.each([
  "darwin",
  "win32",
] as const)("does not advertise the Linux desktop on %s", (platform) => {
  expect(checkDesktopAvailable(platform, (command) => command)).toBe(false);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "checks actual process launch and workspace I/O, detects denial, and recovers without probe files",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-ready-"));
    try {
      expect(await checkAgentWorkspace(directory)).toBe(true);
      expect(await readdir(directory)).toEqual([]);
      await chmod(directory, 0o500);
      expect(await checkAgentWorkspace(directory)).toBe(false);
      await chmod(directory, 0o700);
      expect(await checkAgentWorkspace(directory)).toBe(true);
      expect(await readdir(directory)).toEqual([]);
      expect(await checkAgentWorkspace(join(directory, "missing"))).toBe(false);
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("coalesces simultaneous probes and retries after a failure", async () => {
  let calls = 0;
  const health = new ComputerReadiness(async () => {
    calls++;
    await Bun.sleep(5);
    return calls > 1;
  }, 0);
  expect(await Promise.all(Array.from({ length: 10 }, () => health.check()))).toEqual(
    Array(10).fill(false)
  );
  expect(calls).toBe(1);
  expect(await health.check()).toBe(true);
  expect(calls).toBe(2);
});

test("caches probes and turns process errors into unavailable", async () => {
  let calls = 0;
  const health = new ComputerReadiness(async () => {
    calls++;
    throw new Error("private detail");
  });
  expect(await health.check()).toBe(false);
  expect(await health.check()).toBe(false);
  expect(calls).toBe(1);
});
