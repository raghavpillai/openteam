import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

// An isolated, unauthenticated Chromium profile and localhost page. Never adopts user tabs.
test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)(
  "reference browser actions execute against a real synthetic page",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tool-browser-reference-"));
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><title>Contract fixture</title><button id="hold" style="width:150px;height:80px">Hold</button><input aria-label="Name"><select aria-label="Region"><option value="ny">New York</option><option value="ca">California</option></select><div style="height:2000px">Scroll area</div><script>let down=0;window.holds=[];window.wheels=0;document.addEventListener('mousedown',()=>down=performance.now());document.addEventListener('mouseup',()=>holds.push(performance.now()-down));document.addEventListener('wheel',()=>wheels++);</script>`,
          { headers: { "content-type": "text/html" } }
        ),
    });
    const driver = await outOfProcessPlaywright();
    const browser = await driver.playwright.chromium.launch({
      headless: true,
      executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,
    });
    const context = await browser.newContext();
    const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
    const text = (r: any): string =>
      r.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n");
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      expect(text(await session.execute("browser_navigate", { url }))).toBe(
        `Navigated to ${url}\n\nCurrent page: Contract fixture (${url})`
      );
      const snapshot = text(await session.execute("browser_snapshot", {}));
      expect(snapshot).toContain("Captured page snapshot (3 interactive refs)");
      const ref = (label: string) =>
        snapshot
          .split("\n")
          .find((line) => line.includes("[ref=") && line.includes(label))!
          .match(/\[ref=(e\d+)\]/)![1]!;
      const held = await session.execute("browser_click", {
        ref: ref("Hold"),
        element: "Hold",
        holdDurationMs: 120,
        modifiers: ["Shift"],
        offsetX: 5,
      });
      expect(text(held)).toStartWith("Clicked Hold\n\nCurrent page:");
      const page = await (session as any).ensurePage();
      expect(await page.evaluate(() => (window as any).holds.at(-1))).toBeGreaterThanOrEqual(100);
      expect(
        text(
          await session.execute("browser_fill", {
            ref: ref("Name"),
            element: "Name",
            value: "Fixture",
          })
        )
      ).toStartWith("Filled Name\n\nCurrent page:");
      expect(await page.locator("input").inputValue()).toBe("Fixture");
      const selected = await session.execute("browser_select_option", {
        ref: ref("Region"),
        element: "Region",
        values: ["new york"],
      });
      expect(text(selected)).toStartWith(
        'Selected ["ny"] in Region (matched the requested value to the page\'s option by its visible label)'
      );
      expect(await page.locator("select").inputValue()).toBe("ny");
      expect(
        text(
          await session.execute("browser_scroll", {
            ref: ref("Hold"),
            element: "Hold",
            deltaY: 900,
          })
        )
      ).toStartWith("Scrolled Hold into view");
      expect(await page.evaluate(() => (window as any).wheels)).toBe(0);
      expect(text(await session.execute("browser_scroll", { deltaX: 15 }))).toStartWith(
        "Scrolled by (15, 0)"
      );
      const boxResult = await session.execute("browser_get_bounding_box", {
        ref: ref("Hold"),
        element: "Hold",
      });
      expect(text(boxResult)).toContain("Bounding box for Hold\n\nCurrent page:");
      expect(text(boxResult)).toContain('"width":150');
      const tabs = await session.execute("browser_tabs", { action: "list" });
      expect(text(tabs)).toStartWith("Listed 1 tab(s)\n\n[");
      const shot = await session.execute("browser_take_screenshot", {});
      expect(text(shot)).toStartWith("Saved a screenshot to ");
      const image = await readFile(shot.details.path as string);
      expect(image.subarray(1, 4).toString()).toBe("PNG");
      const cdp = await session.execute("browser_cdp", {
        method: "Runtime.evaluate",
        params: { expression: "1+1", returnByValue: true },
      });
      expect(text(cdp)).toStartWith("Ran CDP Runtime.evaluate\n\nCurrent page:");
      expect((cdp.details.result as any).result.value).toBe(2);
    } finally {
      await browser.close();
      await driver.stop();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
