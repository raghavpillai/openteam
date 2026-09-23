import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../src/browser/use";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";

// Disposable browser integration fixtures, never an existing bot's desktop.
const executable = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executable) throw new Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  `<!doctype html><title>Agent reliability</title><input aria-label="Draft"><p id="result"></p><div contenteditable="true" aria-label="Editor">Start</div>
  <button onclick="const a=prompt('First');const b=prompt('Second');document.querySelector('#result').textContent=JSON.stringify([a,b])">Two prompts</button>
  <button onclick="alert('Brief')">Brief alert</button><button onclick="window.open('/popup')">Popup</button><button style="pointer-events:none">Unavailable</button><ul><li class="ui-sortable-handle">Sortable row</li></ul><div class="ui-draggable">Drag widget</div><div class="ui-droppable"><button>Nested target control</button></div><div class="ui-sortable-handle" style="display:none">Hidden drag</div>`, { headers: { "content-type": "text/html" } }) });
const text = (result: any): string => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
async function reference(session: BrowserUseSession, label: string) {
  const line = text(await session.execute("browser_snapshot", {})).split("\n").find(line => line.includes(`"${label}"`) && line.includes("[ref="));
  assert.ok(line, `reference for ${label}`);
  return line.match(/\[ref=([^\]]+)\]/)![1]!;
}
let failures = 0;
async function check(name: string, fn: (endpoint: string, root: string, external: any) => Promise<void>) {
  if (process.env.CASE_FILTER && !name.includes(process.env.CASE_FILTER)) return;
  const root = await mkdtemp(join(tmpdir(), "agent-reliability-"));
  const chrome = spawn(executable!, ["--headless=new", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${root}`], { stdio: "ignore" });
  try {
    let port: string | undefined;
    for (let i = 0; i < 100; i++) {
      try { port = (await readFile(join(root, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
      catch { await Bun.sleep(100); }
    }
    assert.ok(port);
    const endpoint = `http://127.0.0.1:${port}`;
    const driver = await outOfProcessPlaywright();
    const external = await driver.playwright.chromium.connectOverCDP(endpoint);
    // Preserve dialogs when another connection exists, as native Chrome does.
    external.contexts()[0]!.on("dialog", () => {});
    await fn(endpoint, root, external);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`); }
  finally {
    const exited = chrome.exitCode === null && chrome.signalCode === null ? once(chrome, "exit") : Promise.resolve();
    chrome.kill("SIGKILL"); await exited;
    await (await outOfProcessPlaywright()).stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

await check("delayed dual prompt never replays a completed response", async (endpoint, root) => {
  const session = await BrowserUseSession.connect(endpoint, join(root, "shots"));
  await session.execute("browser_navigate", { url: server.url.href });
  const result = await session.execute("browser_click", { ref: await reference(session, "Two prompts") });
  assert.equal((result.details?.pendingDialog as any)?.message, "First");
  // Reproduce the real 30-second Playwright action timeout from the live audit.
  await Bun.sleep(36_000);
  const second = await session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: "FIRST" } });
  assert.equal((second.details?.pendingDialog as any)?.message, "Second");
  await session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: "SECOND" } });
  await session.execute("browser_snapshot", {});
  assert.equal(await (await (session as any).ensurePage()).locator("#result").textContent(), '["FIRST","SECOND"]');
});

await check("desktop tabs survive adoption, new native tabs and reconnect", async (endpoint, root, external) => {
  const context = external.contexts()[0];
  const native = context.pages()[0];
  await native.goto(server.url.href);
  await native.getByRole("textbox", { name: "Draft" }).fill("NATIVE-DRAFT");
  let session = await BrowserUseSession.connect(endpoint, join(root, "shots"));
  assert.equal((await session.execute("browser_tabs", { action: "list" })).details?.tabs, 1);
  assert.ok(text(await session.execute("browser_snapshot", {})).includes("NATIVE-DRAFT"));
  const firstView = (await session.execute("browser_snapshot", {})).details?.viewId;
  const second = await context.newPage();
  await second.goto(server.url.href + "second");
  await second.getByRole("textbox", { name: "Draft" }).fill("SECOND-DRAFT");
  assert.equal((await session.execute("browser_tabs", { action: "list" })).details?.tabs, 2);
  await session.execute("browser_tabs", { action: "select", index: 1 });
  session = await session.reconnect(endpoint);
  assert.ok(text(await session.execute("browser_snapshot", {})).includes("SECOND-DRAFT"));
  assert.ok(text(await session.execute("browser_snapshot", { viewId: firstView })).includes("NATIVE-DRAFT"));
  const third = await context.newPage();
  await third.goto(server.url.href + "third");
  assert.equal((await session.execute("browser_tabs", { action: "list" })).details?.tabs, 3);
  const nextWorker = await BrowserUseSession.connect(endpoint, join(root, "next-worker"));
  assert.equal((await nextWorker.execute("browser_tabs", { action: "list" })).details?.tabs, 3);
  assert.equal(await native.getByRole("textbox", { name: "Draft" }).inputValue(), "NATIVE-DRAFT");
});

await check("post-dialog observation timeouts remain failures", async (endpoint, root) => {
  const session = await BrowserUseSession.connect(endpoint, join(root, "shots"));
  await session.execute("browser_navigate", { url: server.url.href });
  const opened = await session.execute("browser_click", { ref: await reference(session, "Brief alert") });
  assert.equal((opened.details?.pendingDialog as any)?.message, "Brief");
  // The actual dialog closes successfully, then the pending click's observation
  // fails. Unlike an action that expired while paused, this must stay an error.
  const state = (session as any).pageState.bind(session);
  let failOnce = true;
  (session as any).pageState = (...args: any[]) => {
    if (failOnce && !(session as any).dialogs.size) {
      failOnce = false;
      throw new Error("screenshot: Timeout 100ms exceeded");
    }
    return state(...args);
  };
  await assert.rejects(session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: true } }), /Timeout/);
  assert.ok(text(await session.execute("browser_snapshot", {})).includes("Brief alert"));
});

await check("scripted drag handles expose stable refs without hiding nested controls", async (endpoint, root) => {
  const session = await BrowserUseSession.connect(endpoint, join(root, "shots"));
  await session.execute("browser_navigate", { url: server.url.href });
  const row = await reference(session, "Sortable row");
  const widget = await reference(session, "Drag widget");
  const nested = await reference(session, "Nested target control");
  assert.ok(row && widget && nested);
  const before = text(await session.execute("browser_snapshot", {}));
  assert.ok(!before.includes("Hidden drag"));
  assert.equal(await reference(session, "Sortable row"), row);
  await session.execute("browser_get_bounding_box", { ref: row });
  const page = await (session as any).ensurePage();
  await page.evaluate(() => { document.querySelector(".ui-sortable-handle")!.addEventListener("mousedown", () => { document.querySelector("#result")!.textContent = "drag-started"; }); });
  await session.execute("browser_drag", { sourceRef: row, targetX: 400, targetY: 300 });
  assert.equal(await page.locator("#result").textContent(), "drag-started");
});

await check("typing preserves the editor caret and undo history", async (endpoint, root) => {
  const session = await BrowserUseSession.connect(endpoint, join(root, "shots"));
  await session.execute("browser_navigate", { url: server.url.href });
  const editor = await reference(session, "Editor");
  const original = "First line\nCafé 日本語 🙂\nFinal line";
  await session.execute("browser_fill", { ref: editor, value: original });
  await session.execute("browser_type", { ref: editor, text: "\nTEMP" });
  const page = await (session as any).ensurePage();
  assert.equal(await page.getByLabel("Editor").innerText(), original + "\nTEMP");
  assert.ok(text(await session.execute("browser_snapshot", {})).includes("value=" + JSON.stringify(original + "\nTEMP")), "snapshot preserves exact editor line breaks");
  let undos = 0;
  while ((await page.getByLabel("Editor").innerText()).trimEnd() !== original && undos < 3) {
    await session.execute("browser_press_key", { key: process.platform === "darwin" ? "Meta+z" : "Control+z" });
    undos++;
  }
  assert.equal((await page.getByLabel("Editor").innerText()).trimEnd(), original);
  for (let i = 0; i < undos; i++) await session.execute("browser_press_key", { key: process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z" });
  assert.equal(await page.getByLabel("Editor").innerText(), original + "\nTEMP");
  const draft = await reference(session, "Draft");
  await session.execute("browser_fill", { ref: draft, value: "12345" });
  await page.getByLabel("Draft").evaluate((el: HTMLInputElement) => el.setSelectionRange(1, 3));
  await session.execute("browser_type", { ref: draft, text: "AB" });
  assert.equal(await page.getByLabel("Draft").inputValue(), "1AB45");
  await page.getByLabel("Editor").fill("Leading visible content " + "x".repeat(100) + " SYNTHETIC-SECRET-922");
  await page.evaluate(() => { (window as any).__sandSecretFillValues = new Set(["SYNTHETIC-SECRET-922"]); });
  const secretSnapshot = text(await session.execute("browser_snapshot", {}));
  assert.ok(secretSnapshot.includes('value="<redacted>"'));
  assert.ok(!secretSnapshot.includes("SYNTHETIC-SECRET-922"));
  await page.evaluate(() => { (window as any).__sandSecretFillValues = new Set(); });
  await page.getByLabel("Editor").fill("x".repeat(2001));
  assert.ok(text(await session.execute("browser_snapshot", {})).includes("value-truncated"));

});

await check("popup close review identifies the actual child and opener", async (endpoint, root) => {
  const session = await BrowserUseSession.connect(endpoint, join(root, "shots"));
  await session.execute("browser_navigate", { url: server.url.href, newTab: true });
  const parent = session.tabCloseReviewTarget({});
  await session.execute("browser_click", { ref: await reference(session, "Popup") });
  const child = session.tabCloseReviewTarget({});
  assert.equal(child.target.url, new URL("/popup", server.url).href);
  assert.deepEqual(child.openedBy, parent.target);
  assert.notEqual(child.target.viewId, parent.target.viewId);
  await session.execute("browser_tabs", { action: "close" });
  assert.deepEqual(session.tabCloseReviewTarget({}).target, parent.target);
  // Closing a background tab must not move the selected parent either.
  await session.execute("browser_tabs", { action: "close", index: 0 });
  assert.deepEqual(session.tabCloseReviewTarget({}).target, parent.target);

});

await check("ordinary action timeouts still fail", async (endpoint, root, external) => {
  const session = await BrowserUseSession.connect(endpoint, join(root, "shots"));
  await session.execute("browser_navigate", { url: server.url.href });
  (session as any).context.setDefaultTimeout(100);
  await assert.rejects(session.execute("browser_click", { ref: await reference(session, "Unavailable") }), /[Tt]imeout/);
  assert.ok(text(await session.execute("browser_snapshot", {})).includes("Two prompts"));
});
server.stop(true);
if (failures) process.exitCode = 1;
