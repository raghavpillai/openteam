import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserUseSession } from "../src/browser/use";
import { prepareDownloadPreferences } from "../src/browser/download-preferences";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";

// Run outside bun:test: Playwright's Node IPC driver cannot start in that runner.
// This browser/profile and HTTP fixture are isolated from signed-in user tabs.
const executablePath = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executablePath)
  throw new Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE to a local Chromium executable");
const root = await mkdtemp(join(tmpdir(), "browser-workflows-"));
const downloads = join(root, "Downloads");
const profile = join(root, "profile");
await mkdir(join(profile, "Default"), { recursive: true });
await writeFile(
  join(profile, "Default", "Preferences"),
  JSON.stringify({
    bookmark_bar: { show_on_all_tabs: true },
    download: { directory_upgrade: true },
  })
);
await prepareDownloadPreferences(profile, root);
const prefs = JSON.parse(await readFile(join(profile, "Default", "Preferences"), "utf8"));
assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
assert.equal(prefs.download.directory_upgrade, true);
let downloaded = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    const html = (body: string) =>
      new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } });
    if (path === "/file")
      return new Response(`synthetic-download-${++downloaded}\nCafé 42`, {
        headers: {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="example.txt"',
        },
      });
    if (path === "/slow") {
      let timer: ReturnType<typeof setInterval>;
      return new Response(
        new ReadableStream({
          start(controller) {
            let i = 0;
            controller.enqueue(new TextEncoder().encode("start\n" + "x".repeat(4096)));
            timer = setInterval(() => {
              controller.enqueue(new TextEncoder().encode("chunk\n"));
              if (++i === 8) {
                clearInterval(timer);
                controller.close();
              }
            }, 500);
          },
          cancel() {
            clearInterval(timer);
          },
        }),
        {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="slow.txt"',
          },
        }
      );
    }
    if (path === "/outer")
      return html(
        '<div style="height:65px"></div><iframe src="/inner" style="margin-left:85px;width:550px;height:270px"></iframe>'
      );
    if (path === "/inner")
      return html(
        `<style>button{margin:35px;width:180px;height:70px}</style><button onclick="this.textContent='Embedded complete';top.postMessage('clicked','*')">Embedded action</button><input aria-label="Embedded text">`
      );
    return html(
      `<title>Workflow regression</title><script>window.clicks=0;addEventListener('message',e=>{if(e.data==='clicked')window.clicks++})</script><div style="height:95px">Offset content</div><iframe src="/outer" style="margin-left:120px;width:720px;height:390px"></iframe><p><button id="stale">Stale action</button><a href="/file" download>Download example</a><a href="/slow" download>Slow download</a><input type="file" aria-label="Upload file"></p>`
    );
  },
});
const driver = await outOfProcessPlaywright();
let browserContext: any, session: BrowserUseSession | undefined;
const text = (result: any) =>
  result.content
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
const downloadResults = (result: any): Array<{ path?: string; state: string }> =>
  result.details.downloads ?? [];
try {
  browserContext = await driver.playwright.chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath,
    args: ["--remote-debugging-port=0"],
    viewport: { width: 1280, height: 900 },
  });
  const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
  session = await BrowserUseSession.connect(
    `http://127.0.0.1:${port}`,
    join(root, "artifacts"),
    false,
    downloads
  );
  await session.execute("browser_navigate", { url: server.url.origin });
  const page = await (session as any).ensurePage();
  const ref = async (label: string) => {
    const snapshot = text(await session!.execute("browser_snapshot", {}));
    const line = snapshot.split("\n").find((l: string) => l.includes("[ref=") && l.includes(label));
    assert.ok(line, `Missing snapshot ref for ${label}: ${snapshot}`);
    return line.match(/\[ref=([^\]]+)\]/)![1];
  };
  const embedded = await ref("Embedded action");
  const expectedBox = await page
    .frameLocator("iframe")
    .frameLocator("iframe")
    .getByRole("button")
    .boundingBox();
  const boxResult = text(await session.execute("browser_get_bounding_box", { ref: embedded }));
  assert.ok(boxResult.includes(`"x":${Math.round(expectedBox.x)}`));
  assert.ok(boxResult.includes(`"y":${Math.round(expectedBox.y)}`));
  await session.execute("browser_click", { ref: embedded });
  assert.equal(
    await page.evaluate(() => (window as any).clicks),
    1,
    "nested-frame click must reach its button"
  );
  await session.execute("browser_click", { ref: embedded });
  assert.equal(
    await page.evaluate(() => (window as any).clicks),
    2,
    "same live ref must remain usable"
  );
  const input = await ref("Embedded text");
  await session.execute("browser_fill", { ref: input, element: "Embedded text", value: "Café 42" });
  assert.equal(
    await page.frameLocator("iframe").frameLocator("iframe").getByRole("textbox").inputValue(),
    "Café 42"
  );
  const stale = await ref("Stale action");
  await page.locator("#stale").evaluate((node: any) => node.remove());
  await assert.rejects(
    () => session!.execute("browser_click", { ref: stale }),
    /stale|unknown|not found/
  );
  console.log("PASS nested-frame coordinates, clicks, repeated refs, fill, stale-node rejection");
  const saved: string[] = [];
  for (let i = 0; i < 2; i++) {
    const result = await session.execute("browser_click", { ref: await ref("Download example") });
    const download = downloadResults(result).at(-1)!;
    assert.equal(download.state, "completed");
    assert.ok(download.path);
    saved.push(download.path);
    assert.equal(await readFile(download.path, "utf8"), `synthetic-download-${i + 1}\nCafé 42`);
    assert.ok(text(result).includes(download.path));
  }
  assert.equal(saved[0], join(downloads, "example.txt"));
  assert.equal(saved[1], join(downloads, "example (1).txt"));
  assert.equal(
    await readFile(saved[0]!, "utf8"),
    "synthetic-download-1\nCafé 42",
    "a repeat download must not overwrite the first"
  );
  const dom = (
    await session.execute("browser_cdp", { method: "DOM.getDocument", params: { depth: 0 } })
  ).details.result as any;
  const inputNode = (
    await session.execute("browser_cdp", {
      method: "DOM.querySelector",
      params: { nodeId: dom.root.nodeId, selector: "input[type=file]" },
    })
  ).details.result as any;
  await session.execute("browser_cdp", {
    method: "DOM.setFileInputFiles",
    params: { nodeId: inputNode.nodeId, files: [saved[1]] },
  });
  assert.equal(
    await page.locator("input[type=file]").evaluate((node: any) => node.files[0].name),
    "example (1).txt"
  );
  console.log("PASS download filenames, content, duplicate-name preservation and file upload");
  const stranger = await browserContext.newPage();
  await stranger.goto(server.url.origin);
  await stranger.getByRole("link", { name: "Download example", exact: true }).click();
  const unrelated = downloadResults(await session.execute("browser_take_screenshot", {}));
  assert.equal(unrelated.length, 2, "downloads on unleased tabs must not be disclosed");
  await stranger.close();
  const start = Date.now();
  const slow = await session.execute("browser_click", { ref: await ref("Slow download") });
  assert.equal(downloadResults(slow).at(-1)?.state, "inProgress");
  assert.ok(Date.now() - start < 3500, "slow downloads must not block the tool");
  await new Promise((resolve) => setTimeout(resolve, 4200));
  const completed = downloadResults(await session.execute("browser_take_screenshot", {})).at(-1)!;
  assert.equal(completed.state, "completed");
  assert.ok(completed.path);
  assert.ok((await readFile(completed.path, "utf8")).startsWith("start\n"));
  await (session as any).browser.close();
  session = undefined;
  assert.equal(
    await readFile(saved[1]!, "utf8"),
    "synthetic-download-2\nCafé 42",
    "download must survive CDP disconnect"
  );
  console.log(
    "PASS leased-tab isolation, pending/completed download states and persistence after disconnect"
  );
} finally {
  await (session as any)?.browser.close().catch(() => {});
  await browserContext?.close();
  await driver.stop();
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
