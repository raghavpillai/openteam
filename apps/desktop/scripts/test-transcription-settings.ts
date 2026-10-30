/** Real settings store and browser UI; all keys and upstream addresses are synthetic. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "../../computer/node_modules/playwright-core";
import { createServer } from "vite";
import { TranscriptionStore } from "../../server/src/transcription/store";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "../../output/transcription-saved-key");
const directory = await mkdtemp(join(tmpdir(), "openteam-key-ui-"));
const store = new TranscriptionStore(join(directory, "transcription.json"), () =>
  "fixture-encryption-secret".repeat(2)
);
const initial = {
  enabled: true,
  provider: "openai-compatible" as const,
  baseUrl: "http://audio.test/v1",
  model: "parakeet",
  language: "",
};
await store.save({ ...initial, apiKey: "synthetic-key-A7z9" });
const requests: Array<Record<string, unknown>> = [];
let failSave = false;
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    try {
      if (request.method === "GET") return Response.json(await store.view(), { headers });
      const input = await request.json();
      requests.push(input);
      if (failSave)
        return Response.json(
          { error: { code: "unavailable", message: "Try again shortly." } },
          { status: 503, headers }
        );
      return Response.json(await store.save(input), { headers });
    } catch (error) {
      return Response.json(
        { error: { code: "invalid_transcription_settings", message: (error as Error).message } },
        { status: 400, headers }
      );
    }
  },
});
const vite = await createServer({
  root,
  cacheDir: join(directory, "vite-cache"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
  checks.push(message);
};
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 760, height: 700 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((baseUrl) => {
    (window as any).transcriptionFixture = { baseUrl };
  }, backend.url.origin);
  const open = async () => {
    await page.goto(`${vite.resolvedUrls!.local[0]}test/browser/transcription-settings.html`);
    await page.getByPlaceholder("••••A7z9").waitFor();
  };
  const save = page.getByRole("button", { name: "Save", exact: true });
  const key = page.getByLabel("Transcription API key");
  const language = page.getByLabel("Transcription language");
  const deleteKey = page.getByRole("button", { name: "Delete key", exact: true });
  const credentials = page.getByTestId("transcription-credentials");
  await open();
  assert(
    (await key.inputValue()) === "",
    "Saved suffix is a placeholder; the full key never populates the field"
  );
  assert(await save.isDisabled(), "Saved settings have no pending edits");
  assert((await page.getByRole("switch").count()) === 1, "Only voice notes use a switch");
  await credentials.screenshot({ path: join(output, "after.png") });
  await page.screenshot({ path: join(output, "full-form.png"), fullPage: true });
  await key.fill("temporary-replacement");
  await key.fill("");
  await language.fill("fr");
  await save.click();
  await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  assert(
    !("apiKey" in requests.at(-1)!),
    "Clearing a replacement field omits the key from the save"
  );
  assert(
    (await store.credentials()).apiKey === "synthetic-key-A7z9",
    "Saving another field preserves the stored key"
  );
  await key.fill("   ");
  assert(await save.isDisabled(), "Whitespace alone does not mark the saved key as changed");
  await deleteKey.click();
  assert(await store.view().then((value) => value.hasApiKey), "Delete is staged until Save");
  await credentials.screenshot({ path: join(output, "delete-pending.png") });
  await page.getByRole("button", { name: "Undo deletion" }).click();
  assert(
    (await key.getAttribute("placeholder")) === "••••A7z9",
    "Undo restores the saved-key display"
  );
  await deleteKey.click();
  failSave = true;
  await save.click();
  await page.getByRole("alert").filter({ hasText: "Try again shortly" }).waitFor();
  assert(
    await store.view().then((value) => value.hasApiKey),
    "A failed save does not delete the key"
  );
  assert(
    await page.getByRole("button", { name: "Undo deletion" }).isVisible(),
    "Deletion can still be undone after a failed save"
  );
  failSave = false;
  await save.click();
  await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  assert(
    requests.at(-1)!.apiKey === null && !(await store.view()).hasApiKey,
    "Only explicit deletion sends null and removes the stored key"
  );
  assert((await deleteKey.count()) === 0, "Delete action disappears when no key is stored");
  await key.fill("synthetic-key-B8x2");
  await save.click();
  await page.getByPlaceholder("••••B8x2").waitFor();
  assert((await key.inputValue()) === "", "Saving a replacement clears plaintext from the input");
  await page.reload();
  await page.getByPlaceholder("••••B8x2").waitFor();
  assert(
    (await store.credentials()).apiKey === "synthetic-key-B8x2",
    "Replacement suffix and stored key survive reload"
  );
  const endpoint = page.getByLabel("Transcription base URL");
  await endpoint.fill("http://different.test/v1");
  await save.click();
  await page.getByRole("alert").filter({ hasText: "replacement key" }).waitFor();
  assert(
    (await store.credentials()).baseUrl === initial.baseUrl,
    "Changing endpoint without replacing or deleting keeps the original settings intact"
  );
  await page.getByRole("button", { name: "Delete key", exact: true }).click();
  await save.click();
  await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  assert(
    (await store.credentials()).apiKey === null,
    "An explicit delete allows a keyless endpoint change"
  );
  await store.save({ ...initial, apiKey: "synthetic-key-A7z9" });
  await open();
  await page.setViewportSize({ width: 375, height: 800 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Credentials fit a narrow viewport without horizontal overflow"
  );
  await credentials.screenshot({ path: join(output, "after-narrow.png") });
  await page.setViewportSize({ width: 760, height: 700 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await credentials.screenshot({ path: join(output, "after-dark.png") });
  assert(errors.length === 0, `No browser errors: ${errors.join("; ")}`);
  if (process.argv.includes("--record")) {
    await store.save({
      ...initial,
      provider: "openai",
      model: "gpt-transcribe",
      apiKey: "synthetic-key-A7z9",
    });
    const context = await browser.newContext({
      viewport: { width: 1160, height: 900 },
      colorScheme: "light",
      recordVideo: { dir: output, size: { width: 1160, height: 900 } },
    });
    const demo = await context.newPage();
    await demo.addInitScript((baseUrl) => {
      (window as any).transcriptionFixture = { baseUrl };
    }, backend.url.origin);
    const pause = (ms = 1800) => demo.waitForTimeout(ms);
    const demoKey = demo.getByLabel("Transcription API key");
    const demoSave = demo.getByRole("button", { name: "Save", exact: true });
    const provider = demo.getByRole("combobox", { name: "Transcription provider" });
    const remove = demo.getByRole("button", { name: "Delete key", exact: true });
    await demo.goto(`${vite.resolvedUrls!.local[0]}test/browser/transcription-settings.html?full`);
    await demo
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Voice notes", exact: true })
      .click();
    await demo.getByPlaceholder("••••A7z9").waitFor();
    await demoKey.scrollIntoViewIfNeeded();
    await pause(2500);
    await provider.click();
    await demo.getByRole("option", { name: "Deepgram", exact: true }).click();
    await pause();
    await demoSave.click();
    await demo.getByRole("alert").filter({ hasText: "replacement key" }).waitFor();
    await demo.getByRole("alert").scrollIntoViewIfNeeded();
    await pause(3000);
    await provider.click();
    await demo.getByRole("option", { name: "OpenAI", exact: true }).click();
    await pause();
    await demoKey.fill("temporary-key");
    await pause(600);
    await demoKey.fill("");
    await demo.getByLabel("Transcription language").fill("fr");
    await demoSave.click();
    await demo.getByRole("status").filter({ hasText: "Saved." }).waitFor();
    await demo.getByRole("status").scrollIntoViewIfNeeded();
    await pause();
    await demoKey.pressSequentially("synthetic-key-B8x2", { delay: 90 });
    await demoSave.click();
    await demo.getByPlaceholder("••••B8x2").waitFor();
    await demo.getByRole("status").scrollIntoViewIfNeeded();
    await pause(2500);
    await demo.reload();
    await demo
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Voice notes", exact: true })
      .click();
    await demo.getByPlaceholder("••••B8x2").waitFor();
    await demoKey.scrollIntoViewIfNeeded();
    await pause();
    await remove.click();
    await pause();
    await demo.getByRole("button", { name: "Undo deletion", exact: true }).click();
    await pause();
    await demo.getByRole("switch", { name: "Enable voice notes" }).click();
    await remove.click();
    await demoSave.click();
    await demo.getByRole("status").filter({ hasText: "Saved." }).waitFor();
    await demo.getByRole("status").scrollIntoViewIfNeeded();
    await pause(2500);
    await demoKey.pressSequentially("synthetic-key-C9w3", { delay: 90 });
    await demo.getByRole("switch", { name: "Enable voice notes" }).click();
    await demoSave.click();
    await demo.getByPlaceholder("••••C9w3").waitFor();
    await demo.getByRole("status").scrollIntoViewIfNeeded();
    await pause(2500);
    await demo.screenshot({ path: join(output, "desktop-full-final.png") });
    const video = demo.video()!;
    await context.close();
    const mp4 = join(output, "desktop-full-walkthrough.mp4");
    const convert = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-i",
        await video.path(),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        mp4,
      ],
      { stdout: "ignore", stderr: "pipe" }
    );
    const conversionError = await new Response(convert.stderr).text();
    if (await convert.exited) throw new Error(conversionError);
    console.log(`Desktop recording: ${mp4}`);
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ checks, output }, null, 2));
} finally {
  await browser?.close();
  await vite.close();
  backend.stop(true);
  await rm(directory, { recursive: true, force: true });
}
