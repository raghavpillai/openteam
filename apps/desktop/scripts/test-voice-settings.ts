/** Exercise the real Voice notes settings against strict server endpoints. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";
import { ServerSetupFixture } from "../../ios/scripts/server-setup-fixture";

const repo = resolve(import.meta.dir, "../../..");
const output = join(repo, "output/voice-settings");
await mkdir(output, { recursive: true });
let setup = new ServerSetupFixture();
let failLoad = false,
  failSave = false,
  failCheck = false;
let writes: Array<{ method: string; input: Record<string, unknown> }> = [];
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const input = request.method === "GET" ? {} : await request.json().catch(() => ({}));
    if (path.endsWith("/transcription")) {
      if (request.method === "GET" && failLoad) {
        failLoad = false;
        return Response.json(
          { error: { message: "Voice settings unavailable." } },
          { status: 400 }
        );
      }
      if (request.method !== "GET") {
        writes.push({ method: request.method, input: input as Record<string, unknown> });
        if (failSave) {
          failSave = false;
          return Response.json(
            { error: { message: "Voice settings save refused." } },
            { status: 400 }
          );
        }
      }
    }
    if (path.endsWith("/transcription/check") && failCheck) {
      failCheck = false;
      return Response.json({
        level: "fail",
        status: "invalid",
        detail: "Transcription provider rejected the key.",
      });
    }
    return setup.handle(path, request.method, input, url) ?? Response.json({}, { status: 404 });
  },
});
const viteCache = await mkdtemp(join(tmpdir(), "openteam-voice-settings-"));
const vite = await createServer({
  root: join(repo, "apps/desktop"),
  cacheDir: join(viteCache, "vite"),
  server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.url.origin } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.ONBOARDING_CHROMIUM ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  for (const mode of ["light", "dark", "narrow"]) {
    setup = new ServerSetupFixture();
    writes = [];
    failLoad = true;
    const page = await browser.newPage({
      viewport: { width: mode === "narrow" ? 760 : 1320, height: 900 },
    });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const field = (name: string) =>
      page.getByRole("textbox", { name: `Transcription ${name}`, exact: true });
    const openVoice = async () =>
      page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Voice notes", exact: true })
        .click();
    const provider = async (name: string) => {
      await page.getByRole("combobox", { name: "Transcription provider" }).click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    const save = async (message = "Saved. Voice notes are enabled on connected devices.") => {
      await button("Save").click();
      await page.getByRole("status").filter({ hasText: message }).waitFor();
    };
    const key = page.getByLabel("Transcription API key", { exact: true });
    await page.goto(
      `${vite.resolvedUrls!.local[0]}test/browser/model-onboarding.html?view=model-settings&theme=${mode === "light" ? "light" : "dark"}`
    );
    await openVoice();
    await page.getByRole("alert").filter({ hasText: "Voice settings unavailable." }).waitFor();
    assert.equal(
      await button("Save").count(),
      0,
      "A failed load must not expose a save with defaults"
    );
    await button("Try again").click();
    await field("model").waitFor();
    assert.equal(
      await field("base URL").count(),
      0,
      "Hosted endpoints do not need an editable URL"
    );
    await key.fill("qa-stale-key");
    await provider("Deepgram");
    assert.equal(await key.inputValue(), "");
    assert.equal(await field("model").inputValue(), "nova-3");
    await page.getByRole("switch", { name: "Enable voice notes" }).click();
    await key.fill("qa-voice-key");
    failSave = true;
    await button("Save").click();
    await page.getByRole("alert").filter({ hasText: "Voice settings save refused." }).waitFor();
    assert.equal(setup.voice.enabled, false);
    assert.equal(await key.inputValue(), "qa-voice-key");
    await save();
    assert.equal(setup.voice.provider, "deepgram");
    assert.equal(setup.voice.configured, true);
    assert.equal(await key.inputValue(), "");
    assert.equal(await key.getAttribute("placeholder"), "Key saved");
    failCheck = true;
    await button("Test connection").click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Transcription provider rejected the key." })
      .waitFor();
    await button("Test connection").click();
    await page.getByRole("status").filter({ hasText: "Voice notes are ready." }).waitFor();
    await field("language").fill("en");
    assert.equal(await button("Test connection").isDisabled(), true);
    await save();
    assert.equal(setup.voice.hasApiKey, true, "Omitting the key preserves the server key");
    assert.equal("apiKey" in writes.at(-1)!.input, false);
    await page.locator(".bot-scrollbar").evaluate((element) => element.scrollTo({ top: 0 }));
    await page.screenshot({ path: join(output, `desktop-${mode}.png`), animations: "disabled" });
    const dialog = await page.getByRole("dialog", { name: "Settings", exact: true }).boundingBox();
    for (const control of [key, field("model"), field("language")]) {
      const box = await control.boundingBox();
      assert.ok(
        box && dialog && box.x >= dialog.x && box.x + box.width <= dialog.x + dialog.width,
        "Fields must fit inside the dialog at narrow widths"
      );
    }
    await button("Close").click();
    await button("Open settings").click();
    await openVoice();
    await page.getByPlaceholder("Key saved").waitFor();
    assert.equal(await field("language").inputValue(), "en");
    assert.equal(
      await page.getByRole("combobox", { name: "Transcription provider" }).innerText(),
      "Deepgram"
    );
    await page.getByRole("switch", { name: "Remove transcription API key" }).click();
    await page.getByRole("switch", { name: "Enable voice notes" }).click();
    await save("Saved. Voice notes are disabled.");
    assert.equal(setup.voice.hasApiKey, false);
    assert.equal(writes.at(-1)!.input.apiKey, null);
    await provider("Custom / OpenAI-compatible");
    await field("base URL").fill("http://audio-server:8000/v1");
    await field("model").fill("qa-whisper");
    await page.getByRole("switch", { name: "Enable voice notes" }).click();
    await save();
    assert.equal(setup.voice.configured, true, "Custom services can work without an API key");
    await button("Test connection").click();
    await page.getByRole("status").filter({ hasText: "Voice notes are ready." }).waitFor();
    assert.ok(writes.every((write) => write.method === "PUT"));
    assert.deepEqual(errors, []);
    console.log(
      `${mode}: Voice notes navigation/load retry, key reset/preservation/removal, PUT save/retry, check failure/retry, custom service and reopen persistence passed; fields fit the dialog`
    );
    await page.close();
  }
} catch (error) {
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: join(output, "failure.png"), animations: "disabled" })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  fixture.stop(true);
  await rm(viteCache, { recursive: true, force: true });
}
