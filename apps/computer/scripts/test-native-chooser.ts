import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext } from "playwright-core";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
import { BrowserUseSession } from "../src/browser/use";
import { performComputerUseAction } from "../src/screen/actions";
import { run } from "../src/screen/processes";

// Run inside a disposable computer image. This creates a private X server,
// browser profile and synthetic file; it never attaches to a user's desktop.
if (process.platform !== "linux") throw new Error("Run this test inside the computer image");
const root = await mkdtemp(join(tmpdir(), "native-chooser-"));
const file = join(root, "sample (1).txt");
const contents = "Native chooser regression\nCafé 42";
await writeFile(file, contents);
await cp(new URL("../../../docker/desktop/config", import.meta.url), join(root, "config"), {
  recursive: true,
});
const xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const displayReady = new Promise<string>((resolve, reject) => {
  xvfb.once("error", reject);
  xvfb.once("exit", (code) => reject(new Error(`Xvfb exited ${code}`)));
  xvfb.stdout!.once("data", (chunk) => resolve(String(chunk).trim()));
});
const driver = await outOfProcessPlaywright();
let context: BrowserContext | undefined;
let session: BrowserUseSession | undefined;
try {
  const display = await displayReady;
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    DISPLAY: `:${display}`,
  };
  context = await driver.playwright.chromium.launchPersistentContext(join(root, "profile"), {
    headless: false,
    executablePath: "/usr/local/bin/google-chrome",
    env,
    args: ["--no-sandbox", "--remote-debugging-port=0", "--window-size=1040,735"],
  });
  const page = context.pages()[0]!;
  await page.setContent(
    '<title>Native chooser regression</title><input type="file" aria-label="Upload file">'
  );
  await page.bringToFront();
  const port = (await readFile(join(root, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0];
  session = await BrowserUseSession.connect(
    `http://127.0.0.1:${port}`,
    root,
    true,
    join(root, "Downloads")
  );
  for (const accept of [false, true]) {
    await page.getByLabel("Upload file").click();
    const chooser = (
      await run("xdotool", ["search", "--sync", "--onlyvisible", "--name", "^Open File$"], {
        env,
        captureStdout: true,
        signal: AbortSignal.timeout(10000),
      })
    )
      .toString()
      .trim()
      .split("\n")
      .at(-1)!;
    for (const action of [
      { action: "key", key: "ctrl+l" },
      { action: "type", text: file },
    ] as const) {
      await performComputerUseAction(action, env);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await session.focusedLoginSite();
    }
    if (accept) {
      const geometry = (
        await run("xdotool", ["getwindowgeometry", "--shell", chooser], {
          env,
          captureStdout: true,
        })
      ).toString();
      const dimensions = Object.fromEntries(
        geometry
          .trim()
          .split("\n")
          .map((line) => line.split("="))
      );
      // The native header's Open button stays visible on our 1280x800 display.
      await performComputerUseAction(
        {
          action: "click",
          x: Number(dimensions.X) + Number(dimensions.WIDTH) - 45,
          y: Number(dimensions.Y) + 25,
        },
        env
      );
      await page.waitForFunction(() => document.querySelector("input")!.files!.length === 1);
      const uploaded = await page
        .getByLabel("Upload file")
        .evaluate(async (input: HTMLInputElement) => {
          const file = input.files![0]!;
          return { name: file.name, text: await file.text() };
        });
      assert.deepEqual(uploaded, { name: "sample (1).txt", text: contents });
    } else {
      // Preserve Chromium's anti-clickjacking behavior: Return must not silently
      // attach a file. The worker must explicitly choose the visible Open button.
      await performComputerUseAction({ action: "key", key: "Return" }, env);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(await page.getByLabel("Upload file").inputValue(), "");
    }
  }
  console.log(
    "PASS native chooser: Return cancels; explicit Open uploads the exact named file and Unicode content at 1280x800"
  );
} finally {
  await (session as any)?.browser.close().catch(() => {});
  await context?.close();
  await driver.stop();
  xvfb.kill();
  await rm(root, { recursive: true, force: true });
}
