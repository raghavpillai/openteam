import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { Browser } from "playwright-core";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
import { ScreenBroker } from "../src/screen-broker";

// This starts the production desktop stack; opt in only in a disposable computer container.
test.skipIf(process.env.OPENTEAM_CUA_DESKTOP_TESTS !== "1")(
  "full desktop multilingual typing",
  async () => {
    const home = await mkdtemp("/tmp/cua-full-");
    const broker = new ScreenBroker(home);
    let browser: Browser | undefined;
    let viewerBrowser: Browser | undefined;
    const driver = await outOfProcessPlaywright();
    const { chromium } = driver.playwright;
    try {
      const status = await broker.ensure("typing-probe", "/workspace");
      const env = await broker.commandEnvironment("typing-probe", "/workspace");
      browser = await chromium.launch({
        executablePath: "/usr/local/bin/google-chrome",
        headless: false,
        env: env as Record<string, string>,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
      });
      const page = await browser.newPage();
      await page.setContent(
        '<textarea id="field"></textarea><script>window.keys=[];document.addEventListener("keydown",e=>window.keys.push({key:e.key,code:e.code,trusted:e.isTrusted}))</script>'
      );
      await page.bringToFront();
      viewerBrowser = await chromium.launch({
        executablePath: "/usr/local/bin/google-chrome",
        args: ["--no-sandbox"],
      });
      const view = await viewerBrowser.newPage();
      await view.goto(
        `http://127.0.0.1:${status.viewerPort}/openteam.html#password=${status.viewerPassword}`
      );
      await view.waitForSelector('[data-connection-state="connected"]');
      const samples = [
        "café Ω 東京 🙂\nline two",
        "naïve résumé — Ελληνικά 中文 한국어 👩🏽‍💻",
        "مرحبا नमस्ते Привет e\u0301",
      ];
      for (let round = 0; round < 12; round++) {
        const text = samples[round % samples.length]!;
        await page.locator("#field").fill("");
        await page.locator("#field").focus();
        if (round % 2 === 0)
          await broker.act("typing-probe", "/workspace", { action: "type", text }, "human");
        else await broker.actComputerUse("typing-probe", "/workspace", [{ action: "type", text }]);
        try {
          await page.waitForFunction(
            (expected) =>
              (document.querySelector("#field") as HTMLTextAreaElement).value === expected,
            text,
            { timeout: 2000 }
          );
        } catch (error) {
          console.error({
            round,
            expected: text,
            observed: await page.locator("#field").inputValue(),
            keys: await page.evaluate(() => (window as unknown as { keys: unknown[] }).keys),
          });
          throw error;
        }
        expect(await page.locator("#field").inputValue()).toBe(text);
      }
      await page.setContent(
        '<button style="position:fixed;inset:0" id="pulse">0</button><script>let n=0;pulse.onclick=e=>{if(e.isTrusted)pulse.textContent=++n}</script>'
      );
      const start = performance.now();
      for (let i = 0; i < 20; i++)
        await broker.act(
          "typing-probe",
          "/workspace",
          { action: "click", x: 400, y: 400, double: true },
          "human"
        );
      expect(await page.locator("#pulse").innerText()).toBe("40");
      expect(performance.now() - start).toBeLessThan(12_000);
      await broker.takeover("typing-probe", "/workspace", true);
      await expect(
        broker.actComputerUse("typing-probe", "/workspace", [{ action: "click", x: 400, y: 400 }])
      ).rejects.toThrow();
      expect(await page.locator("#pulse").innerText()).toBe("40");
      await broker.takeover("typing-probe", "/workspace", false);
      await broker.actComputerUse("typing-probe", "/workspace", [
        { action: "click", x: 400, y: 400 },
      ]);
      expect(await page.locator("#pulse").innerText()).toBe("41");
    } finally {
      await viewerBrowser?.close();
      await browser?.close();
      await broker.destroy("typing-probe");
      await rm(home, { recursive: true, force: true });
      await driver.stop();
    }
  },
  60_000
);
