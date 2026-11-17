/** Records real Settings components with inert API/native fixtures; no release is installed. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "../../output/independent-updates-demo");
await mkdir(output, { recursive: true });
const vite = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await vite.listen();
const address = vite.httpServer!.address();
if (!address || typeof address === "string") throw new Error("Demo server did not start");
const url = `http://127.0.0.1:${address.port}/test/browser/update-queue.html`;
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  recordVideo: { dir: output, size: { width: 1280, height: 860 } },
  colorScheme: "light",
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const wait = (ms: number) => page.waitForTimeout(ms);
const caption = async (text: string) =>
  page.evaluate((text) => {
    let label = document.getElementById("recording-caption");
    if (!label) {
      label = document.createElement("div");
      label.id = "recording-caption";
      label.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1000;background:#171717;color:white;padding:12px 22px;border-radius:12px;font:13px system-ui;box-shadow:0 4px 20px #0002;pointer-events:none";
      document.body.append(label);
    }
    label.textContent = text;
  }, text);
const click = async (name: string) => {
  const button = page.getByRole("button", { name, exact: true });
  await button.hover();
  await wait(350);
  await button.click();
};
const load = async () => {
  await page.goto(url);
  await page.waitForSelector('[data-update-state="ready"]');
};
const evidence: Record<string, unknown> = {};
try {
  await load();
  await page.screenshot({ path: resolve(output, "01-independent-controls.png") });
  await caption("1. Update just the server — keep your current desktop");
  await wait(2400);
  await page.evaluate("updateDemo.duration=700");
  await click("Update");
  await wait(500);
  await click("Click Again to Confirm: Update");
  await page.waitForSelector('[data-update-state="up-to-date"]');
  evidence.serverOnly = await page.evaluate(
    "({posts:updateDemo.posts,downloads:updateDemo.downloads,installs:updateDemo.installs})"
  );
  await caption("Server is now 0.0.19. Desktop stays on 0.0.18.");
  await wait(2300);

  await load();
  await caption("2. Update just the desktop — leave the server as it is");
  await page.evaluate("updateDemo.duration=1600");
  await wait(2200);
  await click("Update desktop");
  await page.getByRole("alertdialog").waitFor();
  evidence.desktopOnly = await page.evaluate(
    "({posts:updateDemo.posts,downloads:updateDemo.downloads,installs:updateDemo.installs})"
  );
  await caption("Desktop download ready. Restart now, or keep working.");
  await wait(2100);
  await click("Not now");
  await wait(1200);

  await load();
  await caption("3. Or update both in order — server first, desktop last");
  await page.evaluate("updateDemo.duration=2000");
  await wait(1800);
  await click("Update both…");
  await page
    .getByRole("button", { name: "Update both", exact: true })
    .waitFor({ state: "visible" });
  await wait(2400);
  await page.screenshot({ path: resolve(output, "02-review-order.png") });
  await click("Update both");
  await page.waitForSelector('[data-update-queue="running"]');
  await caption("The server updates and verifies its health. Desktop waits in the queue.");
  await wait(4500);
  await page.screenshot({ path: resolve(output, "03-server-first.png") });
  await page.waitForFunction("updateDemo.downloads===1", { timeout: 20000 });
  await caption("Server verified on 0.0.19. Now the desktop downloads.");
  await wait(1700);
  await page.screenshot({ path: resolve(output, "04-desktop-next.png") });
  await page.getByRole("alertdialog").waitFor();
  await caption("Desktop restarts last — only when you choose Restart to update.");
  await wait(3000);
  await click("Not now");
  await page.waitForSelector('[data-update-queue="complete"]');
  evidence.both = await page.evaluate(
    "({events:updateDemo.events,posts:updateDemo.posts,downloads:updateDemo.downloads,installs:updateDemo.installs})"
  );
  await page.screenshot({ path: resolve(output, "05-queue-complete.png") });
  await caption("Done: server updated, desktop ready. No automatic restart.");
  await wait(2800);
  if (errors.length) throw new Error(errors.join("\n"));
  const video = page.video()!;
  await context.close();
  const recording = await video.path();
  const mp4 = resolve(output, "independent-updates.mp4");
  const convert = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-i",
      recording,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4,
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  const [code, stderr] = await Promise.all([convert.exited, new Response(convert.stderr).text()]);
  if (code) throw new Error(stderr);
  await writeFile(
    resolve(output, "evidence.json"),
    JSON.stringify({ simulated: true, ...evidence, errors, mp4 }, null, 2)
  );
  console.log(mp4);
} finally {
  await browser.close();
  await vite.close();
}
