// Fixture checks of the shipping desktop renderer, each against synthetic or controlled backends:
//   chat           composer focus/IME, ordering, thinking, history anchoring, email draft review and
//                  send-off, question cards, sent-message delivery states (desktop-parity-edges.tsx),
//                  answered questions surviving stale history pages (question-history.tsx), and
//                  ScreenBot account fencing in its composer (screenbot-composer.tsx); all self-reporting
//   updates        desktop self-update and the server update card (updates.tsx + updates-driver.cjs)
//   notifications  notification taps through the real preload and notification manager
//   downloads      native attachment downloads through the real main process and file:// renderer
//   onboarding     the first-run wizard in Chrome via Playwright, against strict setup endpoints
// Usage: bun scripts/test-fixtures.ts [suite ...]   (default: every suite, one at a time)
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";
import type { WebProvidersInput, WebProvidersView } from "@openteam/contracts/web-search";
import { ServerSetupFixture } from "../../ios/scripts/server-setup-fixture";
import { electron, runAndPrint } from "../test/browser/run-electron-fixture";

const root = resolve(import.meta.dir, "..");
async function bundle(entry: string, outdir: string, naming: string, format: "cjs" | "esm" = "cjs") {
  const output = await Bun.build({ entrypoints: [join(root, entry)], outdir, naming, target: "node", format, external: ["electron"] });
  if (!output.success) throw new AggregateError(output.logs, `Could not bundle ${entry}`);
}

async function chat() {
  await runAndPrint({ name: "chat", page: "desktop-parity-edges", timeoutMs: 120_000 });
  await runAndPrint({ name: "question-history", page: "question-history", timeoutMs: 60_000 });
  await runAndPrint({ name: "screenbot", page: "screenbot-composer", timeoutMs: 60_000 });
}

async function updates() {
  await runAndPrint({ name: "updates", page: "updates", driver: "updates-driver.cjs", timeoutMs: 120_000 });
}

async function notifications() {
  await runAndPrint({
    name: "notifications",
    page: "notification-opening",
    driver: "notification-opening-driver.cjs",
    timeoutMs: 120_000,
    async prepare(directory) {
      await bundle("src/preload/index.ts", directory, "preload.cjs");
      await bundle("src/main/notifications.ts", directory, "notifications.cjs");
    },
  });
}

async function downloads() {
  // Exercises the real main process, sandboxed preload, file:// preview UI, net.fetch,
  // and filesystem. Only the native picker/warning dialogs have scripted responses.
  const directory = await mkdtemp(join(tmpdir(), "openteam-asset-downloads-"));
  const pdfPath = process.env.ASSET_DOWNLOAD_PDF ?? resolve(root, "../computer/test/fixtures/input-parity/three-pages.pdf");
  const pdf = await readFile(pdfPath);
  const asset = createHash("sha256").update(pdf).digest("hex");
  const token = "native-download-fixture-token";
  const requests: Array<{ download: boolean; authorized: boolean }> = [];
  let redirected = false;
  let mode = "success";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" };
      if (request.method === "OPTIONS") return new Response(null, { headers });
      if (url.pathname === "/api/auth/config") return Response.json({ mode: "required" }, { headers });
      if (url.pathname === "/api/auth/get-session") return Response.json({
        session: { id: "fixture-session" },
        user: { id: "fixture-owner", name: "Fixture", email: "fixture@example.test" },
      }, { headers });
      if (url.pathname.startsWith("/fixture-mode/")) {
        mode = url.pathname.split("/").at(-1)!;
        return new Response(null);
      }
      if (url.pathname === "/redirect-target") {
        redirected = true;
        return new Response("Redirect must never be followed", { headers });
      }
      if (url.pathname !== `/api/v0/assets/${asset}`) return new Response(null, { status: 404, headers });
      const authorized = request.headers.get("authorization") === `Bearer ${token}`;
      requests.push({ download: url.searchParams.get("download") === "1", authorized });
      if (!authorized || mode === "unauthorized") return new Response(null, { status: 401, headers });
      if (mode === "redirect") return new Response(null, { status: 302, headers: { ...headers, location: "/redirect-target" } });
      return new Response(pdf, { headers: { ...headers, "content-type": "application/pdf", "content-length": String(pdf.length) } });
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const nativeDirectory = join(directory, "dist-electron");
    await mkdir(nativeDirectory);
    await bundle("src/main/index.ts", nativeDirectory, "main.js", "esm");
    await bundle("src/preload/index.ts", nativeDirectory, "preload.cjs");
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      logLevel: "error",
      build: {
        outDir: join(directory, "dist"),
        emptyOutDir: true,
        rolldownOptions: { input: join(root, "test/browser/fixture.html") },
      },
    });
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      server: `http://127.0.0.1:${server.port}`,
      otherServer: `http://localhost:${server.port}`,
      renderer: join(directory, "dist/test/browser/fixture.html"),
      asset, bytes: pdf.length, token,
    }));
    await copyFile(join(root, "test/browser/asset-download-driver.cjs"), join(directory, "driver.cjs"));
    child = Bun.spawn([electron, join(directory, "driver.cjs")], {
      stdin: "ignore",
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        OPENTEAM_SERVER_URL: undefined,
        OPENTEAM_RENDERER_URL: undefined,
        OPENTEAM_HOST_BRIDGE_PORT: "0",
        OPENTEAM_CONTROL_TOKEN: "local-compose-only-change-me",
        ASSET_DOWNLOAD_DIR: directory,
      },
      stdout: "pipe", stderr: "pipe",
    });
    timeout = setTimeout(() => child?.kill("SIGKILL"), 30_000);
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8").catch(() => "{}"));
    if (code || result.error || !result.checks?.length) throw new Error(JSON.stringify({ code, result, stdout, stderr }));
    if (!requests.some(request => !request.download && request.authorized)) throw new Error("PDF preview never fetched authenticated bytes");
    if (requests.some(request => !request.authorized) || redirected) throw new Error("Authentication or redirect guard failed");
    const downloads = requests.filter(request => request.download).length;
    if (downloads !== 4) throw new Error(`Unexpected native asset fetch count: ${downloads}`);
    console.log(JSON.stringify({ ...result, bytes: pdf.length, authenticatedNativeRequests: downloads }, null, 2));
  } finally {
    if (timeout) clearTimeout(timeout);
    child?.kill();
    if (child) await child.exited;
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Run the actual setup screens against strict, deterministic server endpoints. */
async function onboarding() {
  const scratch = await mkdtemp(join(tmpdir(), "openteam-onboarding-"));
  const setup = new ServerSetupFixture();
  const methods: string[] = [];
  let failVoiceCheck = false;

  /** Search starts off, as on a fresh server. A key containing "bad" fails its check. */
  const searchOff = (): WebProvidersView => ({
    search: { selected: null, providers: {} },
    fetch: { selected: "builtin", providers: {} },
  });
  const web = searchOff();
  const searchKeys = new Map<string, string>();
  function webProviders(path: string, method: string, input: unknown): Response | undefined {
    if (path === "/api/v0/server-settings/web-providers") {
      if (method === "GET") return Response.json(web);
      if (method !== "PATCH") return Response.json({ message: "Use PATCH." }, { status: 405 });
      const search = (input as WebProvidersInput).search ?? {};
      for (const [id, { apiKey }] of Object.entries(search.providers ?? {})) {
        if (apiKey === undefined) continue;
        if (apiKey) searchKeys.set(id, apiKey);
        else searchKeys.delete(id);
        web.search.providers[id] = { secretSaved: Boolean(apiKey), ready: Boolean(apiKey), check: null };
      }
      if (search.selected !== undefined) {
        if (search.selected && !searchKeys.has(search.selected)) {
          return Response.json({ message: "Add the API key first." }, { status: 400 });
        }
        web.search.selected = search.selected as WebProvidersView["search"]["selected"];
      }
      return Response.json(web);
    }
    if (path === "/api/v0/server-settings/web-providers/check" && method === "POST") {
      const { provider } = input as { provider: string };
      const key = searchKeys.get(provider);
      const state = web.search.providers[provider];
      if (!key || !state) return Response.json({ message: "Add the API key first." }, { status: 400 });
      const passed = !key.includes("bad");
      state.check = {
        status: passed ? "passed" : "failed",
        message: passed ? "Search returned results." : "The search service refused the key.",
        checkedAt: new Date().toISOString(),
      };
      return Response.json(web);
    }
  }

  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      const input = method === "GET" ? {} : await request.json().catch(() => ({}));
      if (path.endsWith("/transcription") && method !== "GET") methods.push(method);
      if (path.endsWith("/transcription/check") && failVoiceCheck) {
        failVoiceCheck = false;
        return Response.json({ error: { message: "Voice service refused the key." } }, { status: 400 });
      }
      return (
        webProviders(path, method, input) ??
        setup.handle(path, method, input, url) ??
        Response.json({ message: `Unexpected request: ${method} ${path}` }, { status: 404 })
      );
    },
  });
  const vite = await createServer({
    root,
    cacheDir: join(scratch, "vite"),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.url.origin } } },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen();
    const base = vite.resolvedUrls?.local[0];
    assert.ok(base, "Vite must expose a local URL");
    browser = await chromium.launch({
      executablePath: process.env.ONBOARDING_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      timeout: 30_000,
    });
    const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}test/browser/fixture.html?page=model-onboarding&theme=dark&createFails=1`);
    const title = (value: string) => page.getByRole("heading", { name: value, exact: true }).waitFor();
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    await title("You're already connected");
    for (const back of ["button", "escape"]) {
      await button("Use a different AI").click();
      await title("Choose your bots' AI");
      assert.equal(await page.getByText("Skip for now", { exact: false }).count(), 0);
      if (back === "button") await button("Back").click();
      else await page.keyboard.press("Escape");
      await title("You're already connected");
    }

    await button("Use a different AI").click();
    await page.getByRole("button", { name: /^ChatGPT Your/ }).click();
    await page.getByRole("button", { name: /^Use an OpenAI API key/ }).click();
    await page.getByRole("textbox", { name: "API key" }).fill("qa-invalid-key");
    await button("Connect").click();
    await page.getByText("OpenAI didn't accept that key. Check it and try again.").waitFor();
    await page.keyboard.press("Escape");
    await title("Connect ChatGPT");
    await page.keyboard.press("Escape");
    await title("You're already connected");
    await page.getByText("OpenRouter · Saved QA model is connected and replying.").waitFor();
    await button("Keep it").click();
    await title("Let your bots search the web");
    await page.getByRole("button", { name: /^Search provider: Exa/ }).getByText("Recommended").waitFor();
    const searchKey = page.getByRole("textbox", { name: "Exa API key" });
    await searchKey.fill("qa-bad-search-key");
    await button("Turn on web search").click();
    await page.getByText("The search service refused the key.").waitFor();
    assert.equal(web.search.selected, null);
    assert.equal(web.search.providers.exa?.secretSaved, false);
    await searchKey.fill("qa-search-key");
    await button("Turn on web search").click();
    await title("Web search is on");
    assert.equal(web.search.selected, "exa");
    await title("Talk instead of type?");
    const key = page.getByRole("textbox", { name: "API key" });
    await key.fill("qa-openai-key");
    await page.getByRole("radio", { name: "Deepgram" }).click();
    assert.equal(await key.inputValue(), "");
    await key.fill("qa-voice-key");
    failVoiceCheck = true;
    await button("Turn on voice notes").click();
    await page.getByText("Voice service refused the key.").waitFor();
    assert.equal(setup.voice.enabled, false);
    await button("Turn on voice notes").click();
    await title("Voice notes are on");
    assert.equal(setup.voice.configured, true);
    assert.deepEqual(methods, ["PUT", "PUT", "PUT"]);
    await title("Create your first bot");
    await page.waitForFunction(() => !document.documentElement.dataset.setupDirection);
    await page.getByRole("textbox", { name: "Bot name" }).fill("My QA bot");
    await button("Create My QA bot").click();
    await page.getByRole("alert").filter({ hasText: "The server couldn't create the bot." }).waitFor();
    await page.evaluate(() => (window as unknown as { openteamQA: { addBot: (name: string) => void } }).openteamQA.addBot("Other QA bot"));
    await title("Other QA bot is already here");
    assert.equal(await page.getByRole("alert").count(), 0);
    await button("Open it").click();
    await page.getByText("Opened bot: Other QA bot", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS onboarding: saved AI Back/Esc, refused alternative, search key rollback, voice key reset, PUT save/rollback/retry, bot error recovery");
  } finally {
    await browser?.close();
    await vite.close();
    fixture.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }
}

const suites = { chat, updates, notifications, downloads, onboarding };
const selected = process.argv.slice(2);
for (const name of selected) if (!(name in suites)) throw new Error(`Unknown suite ${name}; use ${Object.keys(suites).join(", ")}`);
for (const name of selected.length ? selected : Object.keys(suites)) {
  console.log(`== ${name}`);
  await suites[name as keyof typeof suites]();
}
