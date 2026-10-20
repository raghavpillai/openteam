import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("the Node Playwright driver starts under Bun --smol", async () => {
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../src/browser/playwright-driver.ts")).href;
  const script = `
    const timeout = setTimeout(() => process.exit(2), 5000);
    const { outOfProcessPlaywright } = await import(${JSON.stringify(moduleUrl)});
    const driver = await outOfProcessPlaywright();
    try {
      if (driver.playwright.chromium.name() !== "chromium") throw new Error("Driver did not initialize");
    } finally {
      await driver.stop();
      clearTimeout(timeout);
    }
    console.log("driver-ready-and-stopped");
  `;
  const child = Bun.spawn([process.execPath, "--smol", "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim()).toBe("driver-ready-and-stopped");
}, 10_000);
