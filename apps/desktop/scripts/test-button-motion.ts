import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core/index.mjs";

const output = resolve(import.meta.dir, "../../../output/button-motion");
await mkdir(output, { recursive: true });
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false, hmr: false },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const context = await browser.newContext({
      viewport: { width: 900, height: 850 },
      reducedMotion,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/browser/button-motion.html`);
    await page.getByTestId("send").waitFor();
    await page.waitForFunction(() => Boolean((window as any).buttonMotionQA));
    assert(
      await page.evaluate(() => (window as any).buttonMotionQA.ref()),
      "Native button ref lost"
    );
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.evaluate(() => (window as any).buttonMotionQA.loading(false));
      await page.waitForTimeout(220);
      const before = await page.evaluate(() =>
        Object.fromEntries(
          ["send", "shared", "full", "fixed", "icon", "sibling"].map((id) => {
            const element = document.querySelector(`[data-testid=${id}]`)!;
            const box = element.getBoundingClientRect();
            return [id, { width: box.width, x: box.x }];
          })
        )
      );
      const frames = await page.evaluate(async () => {
        const plugin = document.querySelector('section[aria-label="Plugin action"] button')!;
        const pluginBefore = plugin.getBoundingClientRect().width;
        const sharedBefore = document
          .querySelector('[data-testid="shared"]')!
          .getBoundingClientRect().width;
        (window as any).buttonMotionQA.loading(true);
        const frames: {
          width: number;
          sibling: number;
          plugin: number;
          shared: number;
          pluginBefore: number;
          sharedBefore: number;
        }[] = [];
        const start = performance.now();
        while (performance.now() - start < 260) {
          frames.push({
            width: document.querySelector('[data-testid="send"]')!.getBoundingClientRect().width,
            sibling: document.querySelector('[data-testid="sibling"]')!.getBoundingClientRect().x,
            plugin: plugin.getBoundingClientRect().width,
            shared: document.querySelector('[data-testid="shared"]')!.getBoundingClientRect().width,
            pluginBefore,
            sharedBefore,
          });
          await new Promise(requestAnimationFrame);
        }
        return frames;
      });
      const end = frames.at(-1)!;
      assert(end.width > before.send.width + 20, "Sending indicator did not expand the button");
      assert(end.plugin > end.pluginBefore + 15, "Plugin indicator did not expand the button");
      assert(end.shared > end.sharedBefore + 15, "Shared indicator did not expand the button");
      if (reducedMotion === "no-preference") {
        assert(
          Math.abs(frames[0]!.width - before.send.width) < 1,
          "Button jumped to its final width"
        );
        assert(
          frames.some(
            (frame) => frame.width > before.send.width + 2 && frame.width < end.width - 2
          ),
          "No intermediate button widths"
        );
        assert(
          frames.some(
            (frame) => frame.sibling > before.sibling.x + 2 && frame.sibling < end.sibling - 2
          ),
          "Adjacent button jumped"
        );
        for (const key of ["plugin", "shared"] as const) {
          const initial = end[`${key}Before`];
          assert(
            frames.some((frame) => frame[key] > initial + 2 && frame[key] < end[key] - 2),
            `${key} button snapped`
          );
        }
      } else
        assert(
          Math.abs(frames[0]!.width - end.width) < 1,
          "Reduced motion still interpolated width"
        );
      for (const id of ["full", "fixed", "icon"]) {
        assert(
          Math.abs((await page.getByTestId(id).boundingBox())!.width - before[id]!.width) < 1,
          `${id} control resized`
        );
      }
      assert(await page.getByTestId("send").isDisabled(), "Loading button still accepts clicks");
      assert.equal(await page.getByTestId("send").getAttribute("aria-busy"), "true");
      const indicator = page.getByTestId("send").locator(".button-loading-indicator");
      assert.equal(await indicator.getAttribute("aria-hidden"), "true");
      assert.equal((await indicator.boundingBox())!.width, 20);
      await page.getByTestId("send").locator("canvas").waitFor();
      // Inverted primary buttons change ink when disabled. Read the painted
      // dots after that color transition, not just the indicator's existence.
      const palettes = await page.evaluate(() => {
        const selectors = [
          '[data-testid="send"]',
          '[data-testid="shared"]',
          'section[aria-label="Plugin action"] button',
        ];
        return selectors.map((selector) => {
          const button = document.querySelector(selector)!;
          const canvas = button.querySelector("canvas")!;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let total = 0,
            alpha = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            total +=
              (pixels[i]! * 0.2126 + pixels[i + 1]! * 0.7152 + pixels[i + 2]! * 0.0722) *
              pixels[i + 3]!;
            alpha += pixels[i + 3]!;
          }
          const color = getComputedStyle(button).color;
          const sample = document.createElement("canvas").getContext("2d")!;
          sample.fillStyle = color;
          sample.fillRect(0, 0, 1, 1);
          const [r = 0, g = 0, b = 0] = sample.getImageData(0, 0, 1, 1).data;
          return { selector, dots: total / alpha, ink: r * 0.2126 + g * 0.7152 + b * 0.0722 };
        });
      });
      for (const palette of palettes)
        assert.equal(
          palette.dots > 128,
          palette.ink > 128,
          `${palette.selector} orb has the wrong contrast`
        );
      if (theme === "dark" && reducedMotion === "no-preference")
        await page.screenshot({ path: resolve(output, "loading.png") });
      await page.evaluate(() => (window as any).buttonMotionQA.loading(false));
      await page.waitForTimeout(220);
      assert(
        Math.abs((await page.getByTestId("send").boundingBox())!.width - before.send.width) < 1,
        "Button did not return to natural width"
      );
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page.getByTestId("menu").waitFor();
      await page.evaluate(() => (window as any).buttonMotionQA.loading(true));
      assert.equal(await page.getByTestId("menu").getAttribute("aria-busy"), "true");
      assert.equal(await page.getByTestId("menu").getAttribute("data-disabled"), "");
      await page.keyboard.press("ArrowDown");
      assert(
        await page
          .getByRole("menuitem", { name: "Settings", exact: true })
          .evaluate((element) => element === document.activeElement),
        "Menu keyboard navigation lost focus"
      );
      await page.keyboard.press("Escape");
      await page.evaluate(() => (window as any).buttonMotionQA.loading(false));
      await page.waitForTimeout(220);
    }
    // Unrelated streaming/polling updates must not keep restarting the motion.
    await page.evaluate(async () => {
      (window as any).buttonMotionQA.loading(true);
      for (let i = 0; i < 20; i++) {
        (window as any).buttonMotionQA.tick();
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    });
    assert.equal(
      await page
        .getByTestId("send")
        .evaluate(
          (element) =>
            element
              .getAnimations()
              .filter((animation) =>
                animation.effect?.getKeyframes().some((frame) => frame.width !== undefined)
              ).length
        ),
      0,
      "Unrelated updates restarted width animation"
    );
    await page.evaluate(() => (window as any).buttonMotionQA.loading(false));
    await page.waitForTimeout(220);
    if (reducedMotion === "no-preference") {
      await page.evaluate(() => (window as any).buttonMotionQA.loading(true));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForTimeout(40);
      assert.equal(
        await page
          .getByTestId("send")
          .evaluate(
            (element) =>
              element
                .getAnimations()
                .filter((animation) =>
                  animation.effect?.getKeyframes().some((frame) => frame.width !== undefined)
                ).length
          ),
        0,
        "Live reduced motion did not stop the animation"
      );
      await page.emulateMedia({ reducedMotion });
      await page.evaluate(() => (window as any).buttonMotionQA.loading(false));
      await page.waitForTimeout(220);
    }
    // Interrupt an expansion, change the label, and unmount during motion.
    await page.evaluate(async () => {
      (window as any).buttonMotionQA.loading(true);
      await new Promise((resolve) => setTimeout(resolve, 40));
      (window as any).buttonMotionQA.loading(false);
      (window as any).buttonMotionQA.label("Copied to clipboard");
    });
    await page.waitForTimeout(240);
    assert.equal(await page.getByTestId("label").innerText(), "Copied to clipboard");
    assert.equal(
      await page
        .getByTestId("send")
        .evaluate(
          (element) =>
            element
              .getAnimations()
              .filter((animation) =>
                animation.effect?.getKeyframes().some((frame) => frame.width !== undefined)
              ).length
        ),
      0
    );
    await page.evaluate(() => {
      (window as any).buttonMotionQA.loading(true);
      (window as any).buttonMotionQA.mounted(false);
    });
    await page.waitForTimeout(220);
    await page.evaluate(() => (window as any).buttonMotionQA.loading(false));
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    assert.equal(await page.getByLabel("Submissions").innerText(), "1");
    assert.deepEqual(errors, []);
    console.log(
      `${reducedMotion}: smooth width and sibling motion, fixed widths, native refs, menus, submission, interruption, cleanup`
    );
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
