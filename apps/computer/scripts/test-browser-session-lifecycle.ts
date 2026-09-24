import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../src/browser/use";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
import { performComputerUseAction } from "../src/screen/actions";
import { run } from "../src/screen/processes";

const executable = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executable) throw new Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE");
const html = (body: string) => new Response(`<!doctype html><title>Session lifecycle</title>${body}`, { headers: { "content-type": "text/html" } });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  switch (new URL(request.url).pathname) {
    case "/next": return html("<h1>Next page</h1>");
    case "/popup": return html(`<button onclick="window.opener.document.querySelector('#result').textContent='popup confirmed';window.close()">Confirm and close</button>`);
    case "/confirm-close": return html(`<button onclick="if(confirm('Finalize once?')){const result=window.opener.document.querySelector('#result');result.textContent=String((Number(result.textContent)||0)+1);window.close()}">Confirm and close after dialog</button>`);
    case "/onload": return html(`<body onload="document.body.dataset.result=confirm('Popup confirmation')?'accepted':'dismissed'"><h1>Popup ready</h1></body>`);
    case "/frame": return html(`<button onclick="this.textContent='Frame passed'">Frame action</button>`);
    case "/nested": return html(`<p>Nested frame <iframe src="/frame"></iframe></p>`);
    case "/frames": return html(`<p>Frame description <iframe src="/frame"></iframe></p><p>Nested description <iframe src="/nested"></iframe></p>`);
    default: return html(`<button onclick="document.querySelector('#result').textContent=confirm('Lease confirmation')?'accepted':'dismissed'">Confirm</button>
      <button onclick="onbeforeunload=e=>{e.preventDefault();e.returnValue=''}">Arm unsaved change</button>
      <button onclick="window.open('/popup','_blank')">Open popup</button>
      <button onclick="window.open('/onload','_blank')">Open onload popup</button>
      <button onclick="window.open('/confirm-close','_blank')">Open confirm-close popup</button>
      <p id="result">untouched</p>`);
  }
} });
const text = (result: any): string => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
async function bounded<T>(operation: Promise<T>, ms = 5_000, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded (${ms}ms)`)), ms); })]); }
  finally { clearTimeout(timer!); }
}
async function ref(session: BrowserUseSession, label: string) {
  const line = text(await session.execute("browser_snapshot", {})).split("\n").find(line => line.includes(label) && line.includes("[ref="));
  assert.ok(line, `actionable reference for ${label}`);
  return line.match(/\[ref=([^\]]+)\]/)![1]!;
}
let failures = 0;
async function check(name: string, fn: (session: any, endpoint: string, root: string) => Promise<void>) {
  if (process.env.CASE_FILTER && !name.includes(process.env.CASE_FILTER)) return;
  const root = await mkdtemp(join(tmpdir(), "openteam-session-test-"));
  const chrome = spawn(executable!, [...(process.env.DISPLAY ? [] : ["--headless=new"]), "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${root}`], { stdio: "ignore" });
  let driver: any;
  try {
    let port: string | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { port = (await readFile(join(root, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(port, "private test Chrome started");
    const endpoint = `http://127.0.0.1:${port}`;
    const session = await BrowserUseSession.connect(endpoint, join(root, "shots"), false, join(root, "Downloads"));
    driver = await outOfProcessPlaywright();
    await session.execute("browser_navigate", { url: server.url.href });
    await bounded(fn(session, endpoint, root), 25_000);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`); }
  finally {
    const exited = chrome.exitCode === null && chrome.signalCode === null ? once(chrome, "exit") : Promise.resolve();
    chrome.kill("SIGKILL"); await exited;
    // Recovery can replace the original driver within a case.
    if (driver) await (await outOfProcessPlaywright()).stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

await check("independent leases preserve explicit accept and dismiss", async (session, endpoint, root) => {
  const other = await BrowserUseSession.connect(endpoint, join(root, "other"), false, join(root, "Downloads"));
  for (const accept of [true, false]) {
    const opened = await bounded(session.execute("browser_click", { ref: await ref(session, "Confirm") }), 5_000, `open confirm (accept=${accept})`);
    assert.equal(opened.details.pendingDialog.type, "confirm");
    const page = await session.ensurePage();
    await Promise.all([
      // The response must reach the page promptly; allow the tool's subsequent
      // masked screenshots their normal budget on a busy development host.
      bounded(session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept } }), 15_000, `observe answered confirm (accept=${accept})`),
      bounded(page.waitForFunction((expected: string) => document.querySelector("#result")?.textContent === expected, accept ? "accepted" : "dismissed"), 5_000, `apply dialog response (accept=${accept})`),
    ]);
  }
  assert.equal((await other.execute("browser_tabs", { action: "list" })).details.tabs, 1);
});
await check("explicit beforeunload cancel preserves the page without a tool error", async session => {
  await session.execute("browser_click", { ref: await ref(session, "Arm unsaved change") });
  assert.equal((await bounded(session.execute("browser_navigate", { url: new URL("next", server.url).href }))).details.pendingDialog.type, "beforeunload");
  await bounded(session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: false } }));
  assert.equal((await session.ensurePage()).url(), server.url.href);
});
await check("self-closing popup returns surviving parent state without replay", async session => {
  await session.execute("browser_click", { ref: await ref(session, "Open popup") });
  const result = await bounded(session.execute("browser_click", { ref: await ref(session, "Confirm and close") }));
  assert.ok(text(result).includes("closed"));
  assert.equal(await (await session.ensurePage()).locator("#result").textContent(), "popup confirmed");
  assert.equal((await session.execute("browser_tabs", { action: "list" })).details.tabs, 1);
});
await check("accepting a popup dialog that closes its page recovers parent without replay", async session => {
  await session.execute("browser_click", { ref: await ref(session, "Open confirm-close popup") });
  const opened = await bounded(session.execute("browser_click", { ref: await ref(session, "Confirm and close after dialog") }));
  assert.equal(opened.details.pendingDialog?.message, "Finalize once?");
  const result = await bounded(session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: true } }));
  assert.ok(text(result).includes("Popup closed"));
  assert.equal(await (await session.ensurePage()).locator("#result").textContent(), "1");
  assert.equal((await session.execute("browser_tabs", { action: "list" })).details.tabs, 1);
});
await check("onload popup dialog can be answered before page observation finishes", async session => {
  const opened = await bounded(session.execute("browser_click", { ref: await ref(session, "Open onload popup") }));
  assert.equal(opened.details.pendingDialog?.message, "Popup confirmation");
  await bounded(session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: true } }));
  assert.equal(await (await session.ensurePage()).locator("body").getAttribute("data-result"), "accepted");
});
await check("native/external response to an onload popup clears pending state", async session => {
  await bounded(session.execute("browser_click", { ref: await ref(session, "Open onload popup") }));
  const popup = session.leasedPages().find((page: any) => page.url().endsWith("/onload"));
  assert.ok(popup);
  if (process.env.DISPLAY) {
    await run("xdotool", ["search", "--sync", "--onlyvisible", "--name", "Session lifecycle", "windowfocus"], { env: process.env, signal: AbortSignal.timeout(5_000) });
    await performComputerUseAction({ action: "key", key: "Return" }, process.env);
    await bounded(popup.waitForFunction(() => document.body.dataset.result === "accepted"));
  } else await bounded(session.dialogs.get(popup).accept());
  const snapshot = await bounded(session.execute("browser_snapshot", {}));
  assert.equal(snapshot.details.pendingDialog, undefined);
  assert.ok(text(snapshot).includes("Popup ready"));
});
await check("external response before delayed dialog observer enables does not strand the page", async session => {
  const cdpFor = session.cdpFor.bind(session);
  session.cdpFor = async (page: any) => {
    const cdp = await cdpFor(page);
    if (!cdp.__qaDelayedEnable) {
      cdp.__qaDelayedEnable = true;
      const send = cdp.send.bind(cdp);
      cdp.send = async (method: string, params: unknown) => {
        if (method === "Page.enable") await new Promise(resolve => setTimeout(resolve, 150));
        return send(method, params);
      };
    }
    return cdp;
  };
  const opened = await bounded(session.execute("browser_click", { ref: await ref(session, "Open onload popup") }));
  assert.equal(opened.details.pendingDialog?.message, "Popup confirmation");
  const popup = session.leasedPages().find((page: any) => page.url().endsWith("/onload"));
  assert.ok(popup);
  await bounded(session.dialogs.get(popup).accept());
  await bounded(popup.waitForFunction(() => document.body.dataset.result === "accepted"));
  const result = await bounded(session.execute("browser_snapshot", {}));
  assert.equal(result.details.pendingDialog, undefined);
  assert.ok(text(result).includes("Popup ready"));
});
await check("onload popup retains its dialog with an independent lease connected", async (session, endpoint, root) => {
  const other = await BrowserUseSession.connect(endpoint, join(root, "other"), false, join(root, "Downloads"));
  const opened = await bounded(session.execute("browser_click", { ref: await ref(session, "Open onload popup") }));
  assert.equal(opened.details.pendingDialog?.message, "Popup confirmation");
  await bounded(session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: false } }));
  assert.equal(await (await session.ensurePage()).locator("body").getAttribute("data-result"), "dismissed");
  assert.equal((await other.execute("browser_tabs", { action: "list" })).details.tabs, 1);
});
await check("two driver recoveries retain untouched background and selected tabs", async (initial, endpoint) => {
  let session = initial;
  await session.execute("browser_tabs", { action: "new" });
  await session.execute("browser_navigate", { url: new URL("next", server.url).href });
  for (let attempt = 0; attempt < 2; attempt++) {
    const driver: any = await outOfProcessPlaywright();
    const exited = once(driver.playwright.driverProcess, "exit");
    driver.playwright.driverProcess.kill("SIGTERM"); await exited;
    session = await session.reconnect(endpoint);
    assert.equal((await session.execute("browser_tabs", { action: "list" })).details.tabs, 2);
    assert.equal((await session.ensurePage()).url(), new URL("next", server.url).href);
  }
});
await check("frames nested inside text paragraphs expose usable controls", async session => {
  await session.execute("browser_navigate", { url: new URL("frames", server.url).href });
  const snapshot = text(await session.execute("browser_snapshot", {}));
  const refs = snapshot.split("\n").filter(line => line.includes('"Frame action"') && line.includes("[ref="));
  assert.equal(refs.length, 2);
  for (const line of refs) await session.execute("browser_click", { ref: line.match(/\[ref=([^\]]+)\]/)![1] });
  const verified = text(await session.execute("browser_snapshot", {}));
  assert.equal(verified.split("\n").filter(line => line.includes('"Frame passed"')).length, 2);
});
server.stop(true);
if (failures) process.exitCode = 1;
