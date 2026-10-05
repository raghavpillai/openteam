import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { performClipboardOperation } from "../src/screen/clipboard";
import { run } from "../src/screen/processes";

describe.skipIf(process.platform !== "linux" || !Bun.which("Xvfb") || !Bun.which("xclip") || !existsSync("/usr/local/bin/google-chrome"))("native clipboard", () => {
  let xvfb: ChildProcess;
  let browser: Browser;
  let page: Page;
  let env: NodeJS.ProcessEnv;
  const owners: ChildProcess[] = [];
  const retain = (owner: ChildProcess) => owners.push(owner);
  const signal = () => AbortSignal.timeout(8_000);
  beforeAll(async () => {
    xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "pipe"] });
    const display = await new Promise<string>((resolve, reject) => {
      xvfb.once("error", reject);
      xvfb.stdout!.once("data", value => resolve(String(value).trim()));
    });
    env = { ...process.env, DISPLAY: `:${display}` };
    browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", headless: false, env: env as Record<string, string>, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    page = await browser.newPage();
    await page.setContent("<title>Clipboard regression</title><textarea></textarea>");
    await page.bringToFront();
    await run("xdotool", ["search", "--sync", "--onlyvisible", "--class", "chromium", "windowfocus"], { env });
  }, 20_000);
  afterAll(async () => { for (const owner of owners) owner.kill(); await browser?.close(); xvfb?.kill(); });

  test("successive fresh owners paste exact Unicode, multiline and large text", async () => {
    for (const text of ["first", "👋 — 日本語 हिन्दी\n\nnext\ttab", "replacement", "large line\n".repeat(2000)]) {
      await page.locator("textarea").fill("");
      await page.locator("textarea").focus();
      await performClipboardOperation({ action: "paste", text }, env, signal(), retain);
      await page.waitForFunction(text => document.querySelector("textarea")?.value === text, text);
    }
  }, 20_000);

  test("copy and cut return the current Unicode selection and cut removes it", async () => {
    for (const action of ["copy", "cut"] as const) {
      const text = `${action} 👋 日本語`;
      await page.locator("textarea").fill(text);
      await page.locator("textarea").focus();
      await page.locator("textarea").evaluate(element => (element as HTMLTextAreaElement).select());
      expect(await performClipboardOperation({ action }, env, signal(), retain)).toEqual({ text });
      expect(await page.locator("textarea").inputValue()).toBe(action === "cut" ? "" : text);
    }
  });

  test("canceled paste sends no input or clipboard owner", async () => {
    const abort = new AbortController(); abort.abort();
    await page.locator("textarea").fill("unchanged");
    const before = owners.length;
    await expect(performClipboardOperation({ action: "paste", text: "must not arrive" }, env, abort.signal, retain)).rejects.toThrow();
    expect(await page.locator("textarea").inputValue()).toBe("unchanged");
    expect(owners).toHaveLength(before);
  });
});
