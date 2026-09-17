import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { chromium } from "../../computer/node_modules/playwright-core/index.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const output = resolve(process.argv[2] ?? "findings/delivery-failures-2026-09-16");
await mkdir(output, { recursive: true });
let mode = "ok";
let draftState = "pending";
let posts = 0;
let draftSends = 0;
const messages = new Map<string, any>();
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const handleRequest = async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers });
  const url = new URL(request.url);
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });
  if (url.pathname.endsWith("/external-draft")) {
    const { action } = (await request.json()) as { action: string };
    if (action === "refresh" && mode === "draft-disconnected")
      return respond({ error: { message: "Cannot check delivery while disconnected." } }, 503);
    if (action === "send") {
      draftSends++;
      if (mode === "draft-deny")
        return respond(
          {
            error: {
              code: "provider_unavailable",
              message: "Mail provider unavailable. Your draft is saved.",
            },
          },
          503
        );
      draftState = "sent";
    }
    return respond({ message: { id: "draft", metadata: { cardState: draftState } } });
  }
  if (url.pathname.endsWith("/messages") && request.method === "POST") {
    posts++;
    if (mode.startsWith("http-")) {
      const status = Number(mode.slice(5));
      return respond(
        { error: { code: `http_${status}`, message: `Synthetic rejection ${status}` } },
        status
      );
    }
    if (mode === "reject")
      return respond(
        { error: { code: "unauthorized", message: "Sign in again before sending." } },
        401
      );
    if (mode === "server-error" || mode === "probe-unavailable")
      return respond(
        { error: { code: "temporarily_unavailable", message: "Server unavailable." } },
        503
      );
    const body = (await request.json()) as { clientId: string; content: string };
    if (mode === "slow") await delay(400);
    const message = messages.get(body.clientId) ?? {
      id: `message-${body.clientId}`,
      clientId: body.clientId,
      sequence: String(messages.size + 1),
      channelId: "fixture",
      sender: "user",
      senderBotId: null,
      sourceRunId: null,
      content: body.content,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    if (mode !== "unconfirmed") messages.set(body.clientId, message);
    if (mode === "bad-json") return new Response("{broken", { headers });
    if (mode === "empty-response") return respond({});
    return respond({ message });
  }
  if (url.pathname.includes("/message-deliveries/")) {
    if (mode === "probe-unavailable")
      return respond({ error: { message: "Cannot verify delivery" } }, 503);
    const message = messages.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
    return respond(
      message
        ? { status: "accepted", message, acceptedAtMs: Date.parse(message.createdAt) }
        : { status: "not_found" }
    );
  }
  return respond({ tools: [] });
};
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const method = incoming.method ?? "GET";
    const request = new Request(`${serverOrigin}${incoming.url}`, {
      method,
      ...(method !== "GET" && method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handleRequest(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500);
    outgoing.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing fixture server address");
const serverOrigin = `http://127.0.0.1:${address.port}`;
const electronDirectory =
  process.env.OPENTEAM_TEST_ELECTRON === "1"
    ? await mkdtemp(join(tmpdir(), "openteam-delivery-electron-"))
    : null;
if (electronDirectory)
  await writeFile(
    join(electronDirectory, "main.cjs"),
    `
  const {app,BrowserWindow}=require("electron");
  app.setPath("userData",require("node:path").join(__dirname,"profile"));
  app.whenReady().then(() => { const win=new BrowserWindow({show:false,width:1050,height:1000,webPreferences:{backgroundThrottling:false}}); win.loadURL("about:blank"); });
`
  );
let electronPort = 0;
if (electronDirectory) {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address();
  if (!reserved || typeof reserved === "string") throw new Error("Missing Electron test port");
  electronPort = reserved.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
}
const electronEndpoint = `http://127.0.0.1:${electronPort}`;
const electronChild = electronDirectory
  ? spawn(
      createRequire(import.meta.url)("electron"),
      [`--remote-debugging-port=${electronPort}`, join(electronDirectory, "main.cjs")],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: "ignore" }
    )
  : null;
let electronReady = false;
if (electronChild) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${electronEndpoint}/json/version`)).ok) {
        electronReady = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!electronReady) {
    electronChild.kill();
    throw new Error("Disposable Electron did not start");
  }
}
const browser = electronChild
  ? await chromium.connectOverCDP(electronEndpoint)
  : await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
const context = electronChild
  ? browser.contexts()[0]!
  : await browser.newContext({ viewport: { width: 1050, height: 1000 } });
context.setDefaultTimeout(12000);
const page = context.pages()[0] ?? (await context.newPage());
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
let dropNext = false;
let dropDraft = false;
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
  if (dropDraft && url.pathname.endsWith("/external-draft")) {
    dropDraft = false;
    await route.fetch();
    return route.abort("connectionreset");
  }
  if (dropNext && url.pathname.endsWith("/messages") && route.request().method() === "POST") {
    dropNext = false;
    await route.fetch();
    return route.abort("connectionreset");
  }
  return route.continue();
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const fixtureUrl = `http://127.0.0.1:63389/test/browser/delivery-failures.html?server=${encodeURIComponent(serverOrigin)}`;
const editor = () => page.getByRole("textbox", { name: "Message", exact: true });
const chat = () => page.getByRole("region", { name: "Chat delivery" });
const send = async (text: string) => {
  await editor().fill(text);
  await editor().press("Enter");
};
const reset = async (next: string) => {
  console.log(`Scenario: ${next}`);
  await page.goto("about:blank");
  await context.setOffline(false);
  mode = next;
  messages.clear();
  posts = 0;
  draftSends = 0;
  draftState = "pending";
  await page.goto(`${fixtureUrl}&reset=1`);
  await editor().waitFor();
};
try {
  await reset("reject");
  await send("Preserve a rejected message");
  await page.getByRole("alert").filter({ hasText: "Sign in again before sending" }).waitFor();
  assert(
    (await chat().getByText("Preserve a rejected message", { exact: true }).count()) === 1,
    "Rejected text disappeared"
  );
  assert(messages.size === 0, "Rejected message appeared accepted");
  await page.screenshot({ path: resolve(output, "rejected-message.png"), fullPage: true });
  mode = "ok";
  await chat().getByRole("button", { name: "Resend", exact: true }).click();
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
  assert(messages.size === 1, "Corrected rejection did not send exactly once");

  await reset("ok");
  await context.setOffline(true);
  await send("Cancel this queued message");
  await chat().getByText("Will send when reconnected", { exact: true }).waitFor();
  await page.evaluate(() => {
    (window as any).deliveryQA.failStorage(true);
  });
  await chat().getByRole("button", { name: "Cancel", exact: true }).click();
  await chat().getByRole("alert").filter({ hasText: "Could not save message" }).waitFor();
  await page.evaluate(() => {
    (window as any).deliveryQA.failStorage(false);
  });
  await chat().getByRole("button", { name: "Cancel", exact: true }).click();
  await editor().filter({ hasText: "Cancel this queued message" }).waitFor();
  assert(posts === 0, "Cancelled offline message reached server");

  await reset("ok");
  await context.setOffline(true);
  await send("Persist through reload");
  await chat().getByText("Will send when reconnected", { exact: true }).waitFor();
  // Restore the page while holding the browser offline event through an init script.
  await context.setOffline(false);
  await page.reload();
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
  assert(messages.size === 1, "Reconnect/reload duplicated the queued message");

  await reset("ok");
  dropNext = true;
  await send("Server accepted but response lost");
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
  assert(posts === 1 && messages.size === 1, "Lost acknowledgement caused duplicate send");

  await reset("server-error");
  await send("Recover a failed server request");
  await page.locator('article[data-phase="queued"]').waitFor();
  assert(messages.size === 0, "Unavailable server accepted a message");
  mode = "ok";
  await page.evaluate(() => (window as any).deliveryQA.flush());
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
  await reset("unconfirmed");
  await send("Recover unconfirmed delivery");
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
  await page.evaluate(() => (window as any).deliveryQA.expire());
  await page.locator('article[data-phase="failed"]').waitFor();
  mode = "probe-unavailable";
  await chat().getByRole("button", { name: "Resend", exact: true }).click();
  await chat().getByRole("alert").filter({ hasText: "Delivery is still unconfirmed" }).waitFor();
  assert(
    messages.size === 0 && posts === 1,
    "An unavailable acceptance probe allowed an uncertain resend"
  );
  mode = "unconfirmed";
  await page.evaluate(() => {
    (window as any).deliveryQA.failStorage(true);
  });
  await chat().getByRole("button", { name: "Resend", exact: true }).click();
  await chat().getByRole("alert").filter({ hasText: "Could not save message" }).waitFor();
  await page.evaluate(() => {
    (window as any).deliveryQA.failStorage(false);
  });
  mode = "ok";
  await chat().getByRole("button", { name: "Resend", exact: true }).click();
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
  assert(messages.size === 1, "Recovered send was duplicated");

  await reset("ok");
  await page.evaluate(() => {
    (window as any).deliveryQA.failStorage(true);
  });
  await send("Device storage failed");
  await page.getByRole("alert").filter({ hasText: "Message not sent" }).waitFor();
  assert(
    (await editor().innerText()) === "Device storage failed",
    "Storage failure discarded text"
  );
  assert(posts === 0, "Sent before persisting the journal");

  await reset("ok");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "failure.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic attachment"),
    });
  await send("Keep text with rejected attachment");
  await page.getByRole("alert").filter({ hasText: "This attachment cannot be uploaded" }).waitFor();
  assert(
    (await editor().innerText()) === "Keep text with rejected attachment",
    "Attachment failure hid recovered text"
  );
  assert(posts === 0, "Uncommitted attachment reached send endpoint");

  await reset("ok");
  await page.evaluate(() => (window as any).deliveryQA.hangUploads());
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "late-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic timeout"),
    });
  await send("Keep text during a stuck upload");
  await page.locator('article[data-phase="queued"]').waitFor();
  await chat().getByRole("button", { name: "Cancel", exact: true }).click();
  await editor().filter({ hasText: "Keep text during a stuck upload" }).waitFor();
  await page.getByRole("button", { name: "Remove late-upload.txt", exact: true }).waitFor();
  assert(posts === 0, "A timed-out attachment dispatched its message");

  await reset("slow");
  await send("Show pending delivery");
  await chat().getByText("Sending…", { exact: true }).waitFor();
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();

  await reset("draft-deny");
  const draft = page.getByRole("region", { name: "External message draft" });
  await draft.getByRole("button", { name: "Send", exact: true }).click();
  await draft.getByRole("alert").filter({ hasText: "Mail provider unavailable" }).waitFor();
  assert(
    (await draft.getByLabel("Message body").inputValue()) === "Keep this draft on failure",
    "Provider failure discarded the draft"
  );
  assert(
    (await draft.getByText("Message sent", { exact: true }).count()) === 0,
    "Failed provider send showed success"
  );
  mode = "ok";
  await draft.getByRole("button", { name: "Send", exact: true }).click();
  await draft.getByText("Message sent", { exact: true }).waitFor();
  assert(draftSends === 2, "Unexpected automatic external resend");
  await reset("draft-disconnected");
  dropDraft = true;
  await draft.getByRole("button", { name: "Send", exact: true }).click();
  await draft.getByRole("button", { name: "Check delivery", exact: true }).waitFor();
  assert(
    (await draft.getByRole("button", { name: "Send", exact: true }).count()) === 0,
    "Uncertain external send could be resent"
  );
  assert(draftSends === 1, "Uncertain send retried automatically");
  mode = "ok";
  await draft.getByRole("button", { name: "Check delivery", exact: true }).click();
  await draft.getByText("Message sent", { exact: true }).waitFor();
  assert(draftSends === 1, "Checking delivery sent the message again");
  // Deterministic HTTP rejection vs a retryable outage, through the real HTTP client.
  for (const status of [400, 403, 404, 409, 413, 422]) {
    await reset(`http-${status}`);
    await send(`Rejected ${status}`);
    await chat()
      .getByRole("alert")
      .filter({ hasText: `Synthetic rejection ${status}` })
      .waitFor();
    assert(messages.size === 0 && posts === 1, `HTTP ${status} was retried or accepted`);
    await page.evaluate(() => (window as any).deliveryQA.failStorage(true));
    await chat().getByRole("button", { name: "Delete", exact: true }).click();
    await chat().getByRole("alert").filter({ hasText: "Could not save message" }).waitFor();
    assert(
      (await chat().getByText(`Rejected ${status}`, { exact: true }).count()) === 1,
      "Failed delete removed the authored message"
    );
    await page.evaluate(() => (window as any).deliveryQA.failStorage(false));
    await chat().getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator("article").waitFor({ state: "detached" });
  }
  for (const status of [408, 425, 429, 500, 502, 504]) {
    await reset(`http-${status}`);
    await send(`Retryable ${status}`);
    await page.locator('article[data-phase="queued"]').waitFor();
    assert(messages.size === 0, `HTTP ${status} showed success`);
    const failedPosts = posts;
    mode = "ok";
    await page.evaluate(() => (window as any).deliveryQA.flush());
    await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
    assert(
      messages.size === 1 && posts === failedPosts + 1,
      `HTTP ${status} did not recover once (${failedPosts} failed, ${posts} total)`
    );
  }
  for (const broken of ["bad-json", "empty-response"]) {
    await reset(broken);
    await send(`Accepted with ${broken}`);
    await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
    assert(
      posts === 1 && messages.size === 1,
      "Malformed acknowledgement duplicated a committed message"
    );
  }
  await reset("ok");
  await context.setOffline(true);
  for (const content of ["Queue first", "Queue second", "Queue third"]) await send(content);
  await page.waitForFunction(
    () => document.querySelectorAll('article[data-phase="queued"]').length === 3
  );
  await context.setOffline(false);
  await page.waitForFunction(
    () => document.querySelectorAll('article[data-phase="accepted-awaiting-echo"]').length === 3
  );
  assert(
    [...messages.values()].map((m) => m.content).join("|") ===
      "Queue first|Queue second|Queue third",
    "Reconnect reordered the queued messages"
  );
  assert(posts === 3, "Reconnect duplicated a queue entry");

  await reset("probe-unavailable");
  await send("Do not silently ignore cancellation");
  await page.locator('article[data-phase="queued"]').waitFor();
  await chat().getByRole("button", { name: "Cancel", exact: true }).click();
  await chat()
    .getByRole("alert")
    .filter({ hasText: "Cannot cancel while delivery is unconfirmed" })
    .waitFor();
  assert(posts === 1 && messages.size === 0, "Unconfirmed cancel caused an extra send");

  // Two DOM events in the same tick catch guards that only rely on React state.
  await reset("slow");
  await editor().fill("Double submit once");
  await editor().evaluate((el) => {
    for (let i = 0; i < 2; i++)
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await page.locator('article[data-phase="accepted-awaiting-echo"]').waitFor();
  assert(posts === 1, "Double Enter dispatched duplicate messages");
  await reset("ok");
  await draft.getByRole("button", { name: "Send", exact: true }).evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await draft.getByText("Message sent", { exact: true }).waitFor();
  assert(draftSends === 1, "Double clicking external Send duplicated delivery");
  assert(pageErrors.length === 0, pageErrors.join("\n"));
  console.log(
    "PASS: rejected send explanation/draft recovery; offline queue/cancel; cancellation and resend storage errors; reload/reconnect; response loss without duplication; server failure/resend; local storage failure; pending indicator; external draft failure/retry; HTTP status matrix; malformed acknowledgements; ordered reconnect; duplicate-click protection."
  );
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  if (electronChild) {
    electronChild.kill();
    await new Promise((resolve) => electronChild.once("exit", resolve));
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (electronDirectory) await rm(electronDirectory, { recursive: true, force: true });
}
