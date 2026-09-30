import {expect, test} from "bun:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BrowserUseSession} from "../../src/browser/use";
import {outOfProcessPlaywright} from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("text waits consider visible duplicates, not only the first match", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-wait-duplicates-"));
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
  const session = new (BrowserUseSession as any)(browser, await browser.newContext(), root) as BrowserUseSession;
  try {
    await session.execute("browser_navigate", {url: "about:blank"});
    const page = await (session as any).ensurePage();
    await page.setContent('<div hidden>Saved receipt</div><div id="visible">Saved receipt</div>');
    await session.execute("browser_wait_for", {text: "Saved receipt"});

    // A hidden template must not make disappearance succeed while a live copy remains.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Still visible")), 300);
    try {
      await expect(session.execute("browser_wait_for", {textGone: "Saved receipt"}, controller.signal)).rejects.toThrow("Still visible");
    } finally { clearTimeout(timer); }

    await page.locator("#visible").evaluate((node: HTMLElement) => { node.hidden = true; });
    await session.execute("browser_wait_for", {textGone: "Saved receipt"});
  } finally {
    await browser.close(); await driver.stop(); await rm(root, {recursive: true, force: true});
  }
}, 20_000);
