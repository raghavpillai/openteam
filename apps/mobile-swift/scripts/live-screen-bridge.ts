/** Run only inside a disposable computer container. Real X11/Chromium, synthetic page. */
import { chromium } from "playwright-core";
import { ScreenBroker } from "../../computer/src/screen-broker";

if (process.env.SWIFT_QA_DISPOSABLE_COMPUTER !== "1")
  throw new Error("Disposable computer opt-in required");
const id = "swift-native-live-screen";
const broker = new ScreenBroker("/tmp/swift-native-live-screen");
await broker.ensure(id, "/workspace");
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: false,
  env: (await broker.commandEnvironment(id, "/workspace")) as Record<string, string>,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setContent(`<!doctype html><title>Swift computer QA</title><style>
body{margin:0;background:#e6edf9;font:24px sans-serif}textarea{box-sizing:border-box;width:100%;height:180px;padding:20px;font:24px sans-serif}
button{display:block;width:100%;height:1100px;background:#c6ddf5;font:32px sans-serif}
</style><textarea id="input" aria-label="Test input" placeholder="Native input appears here"></textarea>
<button id="click">Native pointer target</button><script>
window.receipt={clicks:0,rightClicks:0,moves:0,keys:[]};
document.addEventListener('click',e=>{if(e.isTrusted)receipt.clicks++});
document.addEventListener('contextmenu',e=>{e.preventDefault();if(e.isTrusted)receipt.rightClicks++});
document.addEventListener('pointermove',e=>{if(e.isTrusted && e.buttons)receipt.moves++});
document.addEventListener('keydown',e=>{if(e.isTrusted)receipt.keys.push(e.key)});
</script>`);
await page.bringToFront();
await page.locator("#input").focus();
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8790,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health")
      return Response.json({ purpose: "swift-disposable-live-screen", status: "ready" });
    if (path === "/__qa/reset" && request.method === "POST") {
      await broker.takeover(id, "/workspace", false);
      await page.locator("#input").fill("");
      await page.evaluate(() => {
        (window as any).receipt = { clicks: 0, rightClicks: 0, moves: 0, keys: [] };
        window.scrollTo(0, 0);
      });
      await page.locator("#input").focus();
      return Response.json({ ok: true });
    }
    if (path === "/__qa/state")
      return Response.json(
        await page.evaluate(() => ({
          ...(window as any).receipt,
          text: (document.querySelector("#input") as HTMLTextAreaElement).value,
          scrollY: window.scrollY,
        }))
      );
    try {
      if (path.endsWith("/screen/frame"))
        return new Response(await broker.screenshot(id, "/workspace"), {
          headers: { "Content-Type": "image/png" },
        });
      if (path.endsWith("/screen/actions"))
        return Response.json(await broker.act(id, "/workspace", await request.json(), "human"));
      if (path.endsWith("/screen/takeover"))
        return Response.json(
          await broker.takeover(id, "/workspace", (await request.json()).active)
        );
      if (path.endsWith("/screen")) return Response.json(await broker.ensure(id, "/workspace"));
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json({ message: String(error) }, { status: 503 });
    }
  },
});
console.log("Disposable real desktop ready");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    server.stop(true);
    await browser.close();
    await broker.destroy(id);
    process.exit(0);
  });
