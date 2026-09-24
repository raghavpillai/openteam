import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { BrowserUseSession } from "../src/browser/use";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";

// Independent headless process/profile, never the user's browser. Run on Linux
// and macOS with OPENTEAM_BROWSER_TEST_EXECUTABLE pointing to Chromium/Chrome.
const executable = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executable) throw new Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE");
const root = await mkdtemp(join(tmpdir(), "screenshot-isolation-"));
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  return new Response(`<!doctype html><style>body{margin:0;height:1200px;background:white}.block{position:absolute;left:20px;width:120px;height:60px}#marker{top:20px;background:rgb(0,0,255)}.secret{background:red;top:100px}#bottom{top:1100px}button{position:absolute;top:200px}</style><div class="block" id="marker"></div><div class="block secret" data-openteam-private="true">PRIVATE</div><div class="block secret" id="bottom" data-openteam-private="true">PRIVATE BELOW FOLD</div><button onclick="document.body.dataset.answer=confirm('Screenshot confirmation')?'yes':'no'">Confirm</button>`, { headers: { "content-type": "text/html" } });
} });
const chrome = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${root}`], { stdio: "ignore" });
const Jimp = createJimp({ formats: [png] });
const text = (result: any) => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
let driver: Awaited<ReturnType<typeof outOfProcessPlaywright>> | undefined;
try {
  let port: string | undefined;
  for (let i = 0; i < 80; i++) {
    try { port = (await readFile(join(root, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port);
  driver = await outOfProcessPlaywright();
  const endpoint = `http://127.0.0.1:${port}`;
  const first: any = await BrowserUseSession.connect(endpoint, join(root, "shots"), false, join(root, "Downloads"));
  await first.execute("browser_navigate", { url: fixture.url.href });
  const page = await first.ensurePage();
  const second: any = await BrowserUseSession.connect(endpoint, join(root, "other"), false, join(root, "Downloads"));
  const sibling = await second.ensurePage();
  await sibling.setContent('<title>Unrelated sibling</title><body style="background:lime">SIBLING</body>');
  const monitor = () => {
    (window as any).__focusEvents = [];
    for (const event of ["focus", "blur"]) window.addEventListener(event, () => (window as any).__focusEvents.push(event));
    document.addEventListener("visibilitychange", () => (window as any).__focusEvents.push("visibilitychange"));
  };
  await page.evaluate(monitor);
  await sibling.evaluate(monitor);
  const focus = async () => Promise.all([page, sibling].map(p => p.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState, events: [...(window as any).__focusEvents] }))));
  let captures = 0;
  for (const accept of [true, false]) {
    const line = text(await first.execute("browser_snapshot", {})).split("\n").find(line => line.includes('"Confirm"') && line.includes("[ref="))!;
    const opened = await first.execute("browser_click", { ref: line.match(/\[ref=([^\]]+)\]/)![1] });
    assert.equal(opened.details.pendingDialog?.type, "confirm");
    await first.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept } });
    assert.equal(await page.locator("body").getAttribute("data-answer"), accept ? "yes" : "no");
    // Explicit setup chooses the sibling. Capturing the first must not steal it.
    await sibling.bringToFront();
    for (let index = 0; index < 12; index++) {
      const red = 10 + index;
      await page.evaluate((value: number) => { document.querySelector<HTMLElement>("#marker")!.style.backgroundColor = `rgb(${value},0,255)`; }, red);
      const before = await focus();
      const fullPage = index % 4 === 0;
      console.log(`capture accept=${accept} index=${index} fullPage=${fullPage}`);
      const result = await first.execute("browser_take_screenshot", { fullPage });
      assert.deepEqual(await focus(), before, "capture must not change focus, visibility or focus-event history");
      const image = await Jimp.read(await readFile(result.details.path));
      assert.equal(image.getPixelColor(30, 30), ((red << 24) | 0x0000ffff) >>> 0, "capture must be fresh and from the requested tab");
      assert.equal(image.getPixelColor(30, 110), 0xff00ffff, "private content must remain masked");
      if (fullPage) {
        assert.ok(image.bitmap.height >= 1200);
        assert.equal(image.getPixelColor(30, 1110), 0xff00ffff, "offscreen private content must remain masked");
      }
      captures++;
    }
  }
  // A different CDP client may already be observing this tab. Our temporary
  // subscription must not stop that client's stream when capture finishes.
  const observer = await page.context().newCDPSession(page);
  let observed = 0;
  observer.on("Page.screencastFrame", (event: { sessionId: number }) => {
    observed++;
    void observer.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  const waitForFrame = async (previous: number) => {
    for (let i = 0; observed <= previous && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(observed > previous, "an independent frame subscription must continue");
  };
  try {
    await observer.send("Page.startScreencast", { format: "jpeg", quality: 1 });
    await waitForFrame(0);
    await first.execute("browser_take_screenshot", {});
    for (const red of [201, 202]) {
      const before = observed;
      await page.evaluate((value: number) => { document.querySelector<HTMLElement>("#marker")!.style.backgroundColor = `rgb(${value},0,255)`; }, red);
      await waitForFrame(before);
    }
  } finally {
    await observer.send("Page.stopScreencast");
    await observer.detach();
  }
  console.log(`PASS ${captures} fresh masked captures across two leases and accepted/dismissed dialogs; sibling focus preserved; full-page masks and independent frame subscription verified`);
} finally {
  const exited = chrome.exitCode === null && chrome.signalCode === null ? once(chrome, "exit") : Promise.resolve();
  chrome.kill("SIGKILL"); await exited;
  await driver?.stop();
  fixture.stop(true);
  await rm(root, { recursive: true, force: true });
}
