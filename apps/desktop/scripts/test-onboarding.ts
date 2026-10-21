/** Run the actual setup screens against strict, deterministic server endpoints.
 * Usage: bun apps/desktop/scripts/test-onboarding.ts */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";
import { ServerSetupFixture } from "../../ios/scripts/server-setup-fixture";

const repo = resolve(import.meta.dir, "../../..");
const output = resolve(repo, "output/onboarding-regressions");
await mkdir(output, { recursive: true });
let setup = new ServerSetupFixture();
let methods: string[] = [];
let failVoiceCheck = false;
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
      return Response.json(
        { error: { message: "Voice service refused the key." } },
        { status: 400 }
      );
    }
    return (
      setup.handle(path, method, input, url) ??
      Response.json({ message: `Unexpected request: ${method} ${path}` }, { status: 404 })
    );
  },
});
const vite = await createServer({
  root: join(repo, "apps/desktop"),
  cacheDir: join(await mkdtemp(join(tmpdir(), "openteam-onboarding-")), "vite"),
  server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.url.origin } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  assert.ok(base, "Vite must expose a local URL");
  browser = await chromium.launch({
    executablePath:
      process.env.ONBOARDING_CHROMIUM ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    timeout: 30_000,
  });
  for (const mode of ["light", "dark", "reduced-motion"] as const) {
    setup = new ServerSetupFixture();
    methods = [];
    const page = await browser.newPage({
      viewport: { width: 1320, height: 860 },
      reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference",
    });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}test/browser/model-onboarding.html?theme=${mode}&createFails=1`);
    const title = (value: string) =>
      page.getByRole("heading", { name: value, exact: true }).waitFor();
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
    await page.screenshot({ path: join(output, `${mode}.png`), animations: "disabled" });
    await page.getByRole("textbox", { name: "Bot name" }).fill("My QA bot");
    await button("Create My QA bot").click();
    await page
      .getByRole("alert")
      .filter({ hasText: "The server couldn't create the bot." })
      .waitFor();
    await page.evaluate(() => {
      (window as unknown as { openteamQA: { addBot: (name: string) => void } }).openteamQA.addBot(
        "Other QA bot"
      );
    });
    await title("Other QA bot is already here");
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.screenshot({ path: join(output, `${mode}-arrival.png`), animations: "disabled" });
    await button("Open it").click();
    await page.getByText("Opened bot: Other QA bot", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      `${mode}: saved AI Back/Esc, refused alternative, voice key reset, PUT save/rollback/retry, bot error recovery passed`
    );
    await page.close();
  }
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  fixture.stop(true);
}
