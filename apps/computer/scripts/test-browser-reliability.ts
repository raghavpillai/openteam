import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserUseSession } from "../src/browser/use";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
import { performComputerUseAction } from "../src/screen/actions";
import { run } from "../src/screen/processes";

const executablePath = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE");
const root = await mkdtemp(join(tmpdir(), "browser-reliability-"));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`<!doctype html>
  <title>Reliability fixture</title><button onclick="window.result=confirm('Approve synthetic action?')">Confirm</button>
  <button onclick="window.result=prompt('Synthetic input','default')">Prompt</button>
  <button onclick="alert('Synthetic alert');window.result='acknowledged'">Alert</button>
  <button onclick="window.result=confirm('First confirmation') && confirm('Second confirmation')">Two confirmations</button>
  <div draggable="true" style="width:100px;height:100px;background:red">Drag source</div>
  <output id="status">ready</output><script>setInterval(()=>status.textContent=String(window.result),50)</script>`,
  { headers: { "content-type": "text/html" } }) });
const chrome = spawn(executablePath, [...(process.env.DISPLAY ? [] : ["--headless=new"]), "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${root}`], { stdio: "ignore" });
let session: any;
let currentDriver: Awaited<ReturnType<typeof outOfProcessPlaywright>> | undefined;
const originalFork = childProcess.fork;
let driverProcess: childProcess.ChildProcess | undefined;
childProcess.fork = ((...args: any[]) => { driverProcess = (originalFork as any)(...args); return driverProcess; }) as any;
const text = (result: any) => result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
try {
  let port = "";
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(root, "DevToolsActivePort"), "utf8")).split("\n")[0]!; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, "private Chrome started");
  const endpoint = `http://127.0.0.1:${port}`;
  session = await BrowserUseSession.connect(endpoint, join(root, "shots"), false, join(root, "Downloads"));
  currentDriver = await outOfProcessPlaywright();
  childProcess.fork = originalFork;
  await session.execute("browser_navigate", { url: server.url.href });
  const page = await session.ensurePage();
  const ref = async (label: string) => {
    const snapshot = text(await session.execute("browser_snapshot", {}));
    const match = snapshot.split("\n").find((line: string) => line.includes(label) && line.includes("[ref="))?.match(/\[ref=([^\]]+)\]/);
    assert.ok(match, `reference for ${label}`); return match[1];
  };
  for (const [label, accept, expected, promptText] of [["Confirm", true, true], ["Confirm", false, false], ["Prompt", true, "Café 🙂", "Café 🙂"], ["Prompt", false, null], ["Alert", true, "acknowledged"]] as const) {
    const start = Date.now();
    const opened = await session.execute("browser_click", { ref: await ref(label) });
    assert.ok(opened.details.pendingDialog, "dialog retained and reported");
    assert.ok(Date.now() - start < 5_000, "dialog action returns promptly");
    assert.ok((await session.execute("browser_snapshot", {})).details.pendingDialog);
    await session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept, ...(promptText ? { promptText } : {}) } });
    assert.equal(await page.evaluate(() => (window as any).result), expected);
    console.log(`PASS ${label}: ${accept ? "accept" : "dismiss"}`);
  }
  // A dialog handled on the native surface must clear the managed pending state.
  const native = await session.context.newCDPSession(page);
  await native.send("Page.enable");
  const nativeOpened = await session.execute("browser_click", { ref: await ref("Confirm") });
  assert.ok(nativeOpened.details.pendingDialog);
  if (process.env.DISPLAY) {
    await run("xdotool", ["search", "--sync", "--onlyvisible", "--name", "Reliability fixture", "windowfocus"], { env: process.env, signal: AbortSignal.timeout(5_000) });
    await performComputerUseAction({ action: "key", key: "Return" }, process.env);
    await page.waitForFunction(() => (window as any).result === true);
  } else await native.send("Page.handleJavaScriptDialog", { accept: true });
  await native.detach();
  assert.ok(!(await session.execute("browser_snapshot", {})).details.pendingDialog);
  console.log("PASS external dialog response clears pending state");
  const firstDialog = await session.execute("browser_click", { ref: await ref("Two confirmations") });
  assert.equal(firstDialog.details.pendingDialog.message, "First confirmation");
  const secondDialog = await session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: true } });
  assert.equal(secondDialog.details.pendingDialog.message, "Second confirmation");
  await session.execute("browser_cdp", { method: "Page.handleJavaScriptDialog", params: { accept: false } });
  assert.equal(await page.evaluate(() => (window as any).result), false);
  console.log("PASS consecutive confirmations each require a separate response");
  if (process.env.DISPLAY) {
    const before = await page.evaluate(() => window.devicePixelRatio);
    await performComputerUseAction({ action: "key", key: "ctrl+-" }, process.env);
    await page.waitForFunction(previous => window.devicePixelRatio < previous, before);
    await performComputerUseAction({ action: "key", key: "ctrl++" }, process.env);
    await page.waitForFunction(previous => window.devicePixelRatio >= previous, before);
    console.log("PASS native ctrl+- zooms out and ctrl++ zooms back in");
  }
  assert.ok(await ref("Drag source"));
  console.log("PASS draggable element has an actionable reference");
  for (const key of ["BrowserBack", "Alt+ArrowLeft"]) {
    await session.execute("browser_navigate", { url: new URL("next", server.url).href });
    await session.execute("browser_press_key", { key });
    assert.equal(page.url(), server.url.href);
    await session.execute("browser_press_key", { key: "BrowserForward" });
    assert.equal(page.url(), new URL("next", server.url).href);
    await session.execute("browser_press_key", { key: "Alt+ArrowLeft" });
  }
  console.log("PASS BrowserBack/BrowserForward and Alt+ArrowLeft history shortcuts");
  // Kill only this test's Node driver, leaving its external Chrome intact.
  const exited = once(driverProcess!, "exit");
  driverProcess!.kill("SIGTERM");
  await exited;
  const oldDriver = currentDriver;
  currentDriver = await outOfProcessPlaywright();
  assert.notEqual(currentDriver, oldDriver);
  await oldDriver.stop().catch(() => {});
  assert.equal(await outOfProcessPlaywright(), currentDriver, "stopping stale generation keeps replacement alive");
  const recovered = await session.reconnect(endpoint);
  assert.ok(text(await recovered.execute("browser_snapshot", {})).includes("Reliability fixture"), "owned tab recovered without replaying navigation");
  assert.equal((await recovered.execute("browser_tabs", { action: "list" })).details.tabs, 1, "recovery preserves lease isolation");
  console.log("PASS unexpected driver exit recovers without restarting service");
} finally {
  childProcess.fork = originalFork;
  await currentDriver?.stop();
  const exited = chrome.exitCode === null ? once(chrome, "exit") : Promise.resolve();
  chrome.kill(); await exited;
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
