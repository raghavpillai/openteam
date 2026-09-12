import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Browser, chromium, type Page } from "playwright-core";
import { run } from "../src/screen/processes";
import { ScreenBroker } from "../src/screen-broker";

// Opt in inside a disposable computer container: starts two full Linux desktops.
test.skipIf(process.env.OPENTEAM_CUA_DESKTOP_TESTS !== "1")(
  "concurrent desktops, shared input, interruption and multiple VNC viewers",
  async () => {
    const home = await mkdtemp("/tmp/cua-concurrent-");
    const broker = new ScreenBroker(home);
    const browsers: Browser[] = [];
    const pages: Page[] = [];
    const ids = ["concurrent-a", "concurrent-b"];
    try {
      const statuses = await Promise.all(
        ids.flatMap((id) => Array.from({ length: 6 }, () => broker.ensure(id, "/workspace")))
      );
      expect(new Set(statuses.slice(0, 6).map((s) => s.viewerPassword)).size).toBe(1);
      expect(new Set(statuses.slice(6).map((s) => s.viewerPassword)).size).toBe(1);
      expect(statuses[0]!.display).not.toBe(statuses[6]!.display);
      for (const id of ids) {
        const env = await broker.commandEnvironment(id, "/workspace");
        const browser = await chromium.launch({
          executablePath: "/usr/local/bin/google-chrome",
          headless: false,
          env: env as Record<string, string>,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
        });
        browsers.push(browser);
        const page = await browser.newPage();
        pages.push(page);
        await page.setContent(
          `<title>${id}</title><textarea id="field" style="position:fixed;inset:0;width:100%;height:100%;font:24px sans-serif"></textarea><script>window.trusted=0;field.oninput=e=>{if(e.isTrusted)window.trusted++}</script>`
        );
        await page.bringToFront();
        await page.locator("#field").focus();
      }
      const entries = ids.map((id, index) => ({ id, page: pages[index]! }));
      const chunks = ["café Ω 🙂 ", "東京 한글 ", "Привет 👩🏽‍💻 ", "العربية fin "];
      await Promise.all(
        entries.map(async ({ id, page }) => {
          await Promise.all(
            chunks.map((text, i) =>
              broker.act(
                id,
                "/workspace",
                { action: "type", text: `${id}:${i}:${text}` },
                i % 2 ? "human" : "agent"
              )
            )
          );
          expect(await page.locator("#field").inputValue()).toBe(
            chunks.map((text, i) => `${id}:${i}:${text}`).join("")
          );
        })
      );
      console.info("Two desktops: 8 overlapping multilingual input requests preserved exactly");

      const id = ids[0]!;
      const page = pages[0]!;
      await page.locator("#field").fill("");
      await page.locator("#field").focus();
      const agent = broker
        .actComputerUse(id, "/workspace", [{ action: "type", text: "AGENT ".repeat(2000) }])
        .then(
          () => "finished",
          () => "interrupted"
        );
      await page.waitForFunction(
        () => (document.querySelector("#field") as HTMLTextAreaElement).value.length > 10
      );
      const queued = broker
        .act(id, "/workspace", { action: "type", text: "STALE_INPUT" }, "agent")
        .then(
          () => "ran",
          () => "rejected"
        );
      const t = performance.now();
      await broker.takeover(id, "/workspace", true);
      expect(performance.now() - t).toBeLessThan(2000);
      const stopped = await page.locator("#field").inputValue();
      await broker.act(id, "/workspace", { action: "type", text: " HUMAN" }, "human");
      await broker.takeover(id, "/workspace", false);
      expect(await agent).toBe("interrupted");
      expect(await queued).toBe("rejected");
      expect(await page.locator("#field").inputValue()).toBe(stopped + " HUMAN");
      await broker.actComputerUse(id, "/workspace", [{ action: "type", text: " RESUMED" }]);
      expect(await page.locator("#field").inputValue()).toBe(stopped + " HUMAN RESUMED");
      console.info(
        "Takeover interrupted active typing, rejected stale input, allowed human input and resumed cleanly"
      );

      const env = await broker.commandEnvironment(id, "/workspace");
      const mapping = () => run("xmodmap", ["-pke"], { env, captureStdout: true });
      const before = await mapping();
      const typing = broker
        .act(id, "/workspace", { action: "type", text: "東京Ω🙂".repeat(2000) }, "agent")
        .then(
          () => "finished",
          () => "interrupted"
        );
      await page.waitForFunction(() =>
        (document.querySelector("#field") as HTMLTextAreaElement).value.includes("東")
      );
      await broker.pauseAgent(id, "/workspace", true);
      expect(await typing).toBe("interrupted");
      expect(await mapping()).toEqual(before);
      await expect(
        broker.act(id, "/workspace", { action: "key", keys: ["a"] }, "agent")
      ).rejects.toThrow("paused");
      await broker.pauseAgent(id, "/workspace", false);
      await broker.act(id, "/workspace", { action: "type", text: " clean 🙂" }, "human");
      expect((await page.locator("#field").inputValue()).endsWith(" clean 🙂")).toBe(true);
      console.info("Pause interrupts Unicode input and restores the X11 keymap");

      const viewerBrowser = await chromium.launch({
        executablePath: "/usr/local/bin/google-chrome",
        args: ["--no-sandbox"],
      });
      browsers.push(viewerBrowser);
      const viewerUrl = `http://127.0.0.1:${statuses[0]!.viewerPort}/openteam.html#password=${statuses[0]!.viewerPassword}`;
      const viewers = await Promise.all([
        viewerBrowser.newPage({ viewport: { width: 1280, height: 800 } }),
        viewerBrowser.newPage({ viewport: { width: 1280, height: 800 } }),
      ]);
      await Promise.all(
        viewers.map(async (view) => {
          await view.goto(viewerUrl);
          await view.waitForSelector('[data-connection-state="connected"]');
        })
      );
      await page.locator("#field").fill("");
      const waiting = broker.act(id, "/workspace", { action: "wait", ms: 1500 }, "agent");
      await viewers[0]!.mouse.click(400, 400);
      await viewers[0]!.keyboard.type("VNC_HUMAN");
      await page.waitForFunction(
        () => (document.querySelector("#field") as HTMLTextAreaElement).value === "VNC_HUMAN"
      );
      await waiting;
      await Promise.all(
        viewers.map(async (view) => {
          await view.reload();
          await view.waitForSelector('[data-connection-state="connected"]');
        })
      );
      await broker.actComputerUse(id, "/workspace", [{ action: "type", text: "_AGENT" }]);
      expect(await page.locator("#field").inputValue()).toBe("VNC_HUMAN_AGENT");
      console.info(
        "Two simultaneous VNC viewers, real VNC keyboard input during an agent operation, and reconnects passed"
      );

      const frames = await Promise.all(
        Array.from({ length: 20 }, (_, i) => broker.screenshot(ids[i % 2]!, "/workspace"))
      );
      expect(
        frames.every((frame) => frame[0] === 137 && frame[1] === 80 && frame.length > 1000)
      ).toBe(true);
      expect(await pages[1]!.locator("#field").inputValue()).toBe(
        chunks.map((text, i) => `${ids[1]}:${i}:${text}`).join("")
      );
      console.info(
        "20 concurrent screenshots succeeded; the other desktop retained its exact contents"
      );
    } finally {
      for (const browser of browsers.reverse()) await browser.close();
      await Promise.all(ids.map((id) => broker.destroy(id)));
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000
);
