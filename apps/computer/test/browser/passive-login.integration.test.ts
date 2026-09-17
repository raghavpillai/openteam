import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)(
  "passive saved login detects delayed fields without a tool call, refuses a stale document, and keeps CDP guarded",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "passive-login-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>Fixture</title><main id='login'></main>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const driver = await outOfProcessPlaywright();
    const browser = await driver.playwright.chromium.launch({
      headless: true,
      executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,
    });
    const context = await browser.newContext();
    const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
    let stop = () => {};
    try {
      await session.execute("browser_navigate", { url: server.url.origin });
      const page = await (session as any).ensurePage();
      await page.bringToFront();
      let fills = 0;
      let finishFill!: () => void;
      const fillFinished = new Promise<void>((resolve) => {
        finishFill = resolve;
      });
      stop = session.watchLoginFocus(async (site) => {
        const binding = await session.loginBinding(site, true);
        try {
          if (
            await session.fillSavedLogin(binding, {
              origin: site,
              username: "synthetic-user",
              password: "SYNTHETIC-AUTOFILL",
            })
          ) {
            fills++;
            finishFill();
          }
        } finally {
          await session.releaseLoginBinding(binding);
        }
      });
      // Simulates client-side rendering/manual navigation; no subsequent model tool runs.
      await page.evaluate(() => {
        document.querySelector("main")!.innerHTML =
          '<form><input autocomplete="username"><input id="password" type="password"></form>';
      });
      await page.waitForFunction(
        () =>
          (document.getElementById("password") as HTMLInputElement)?.value === "SYNTHETIC-AUTOFILL",
        undefined,
        { timeout: 6000 }
      );
      await fillFinished;
      expect(fills).toBe(1);
      await expect(
        session.execute("browser_cdp", {
          method: "Runtime.evaluate",
          params: { expression: 'btoa(document.getElementById("password").value)' },
        })
      ).rejects.toThrow("private");
      stop();
      await page.locator("#password").fill("");
      const stale = await session.loginBinding(server.url.origin, true);
      await page.reload();
      try {
        expect(
          await session.fillSavedLogin(stale, {
            origin: server.url.origin,
            password: "SECOND-SYNTHETIC",
          })
        ).toBe(false);
      } finally {
        await session.releaseLoginBinding(stale);
      }
    } finally {
      stop();
      await browser.close();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000
);
