const { createRequire } = require("module");
const { chromium } = createRequire(
  require("node:path").resolve(__dirname, "../../../computer/package.json")
)("playwright-core");
const fs = require("fs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async function runDesktopMediaChecks({ port, url, out }) {
  const b = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  const context = b.contexts()[0];
  const p = context.pages()[0] ?? (await context.waitForEvent("page"));
  p.setDefaultTimeout(9000);
  const checks = [],
    errors = [];
  let phase = "start";
  p.on("pageerror", (e) => errors.push(e.message));
  const check = (ok, message) => {
    if (!ok) throw Error(phase + ": " + message);
    checks.push({ phase, check: message });
  };
  const rect = async (l) => l.evaluate((e) => e.getBoundingClientRect().toJSON());
  const checkFocus = async (locator, message) => {
    await p.waitForFunction(
      (element) => document.activeElement === element,
      await locator.elementHandle()
    );
    check(true, message);
  };
  const load = async (query, width = 1456) => {
    await p.setViewportSize({ width, height: 924 });
    await p.goto(url + "?" + query);
    await p.locator("[contenteditable]").waitFor();
    await p.getByRole("textbox", { name: "Message", exact: true }).fill("");
  };
  const openDetails = async () => {
    if (
      !(await p
        .getByRole("button", { name: "Close details", exact: true })
        .isVisible()
        .catch(() => false))
    )
      await p
        .getByRole("button", { name: "View conversation details", exact: true })
        .first()
        .click();
    await p.getByRole("tab", { name: "Library", exact: true }).waitFor();
    await pause(350);
  };
  const checkStage = async () => {
    await p.waitForFunction(() => {
      const stage = document.querySelector("[data-attachment-stage]");
      return stage && Math.abs(stage.getBoundingClientRect().y - 32) < 0.1;
    });
    const stage = await rect(p.locator("[data-attachment-stage]"));
    check(
      stage.x === 24 && stage.width === p.viewportSize().width - 48,
      "preview floats above the sidebar and details panel with a visible margin"
    );
    check(
      Math.abs(stage.y - 32) < 0.1 && Math.abs(stage.bottom - p.viewportSize().height) < 0.1,
      "preview rises from the bottom edge, below the window controls"
    );
    check(
      (await p.getByRole("dialog").getAttribute("aria-modal")) === "true" &&
        (await p.getByRole("textbox", { name: "Message", exact: true }).count()) === 0,
      "modal preview makes the underlying chat and composer inaccessible"
    );
    check(
      await p.locator("[data-attachment-stage]").evaluate((stage) => {
        const panelPoint = document.elementFromPoint(innerWidth - 40, 100);
        const composerPoint = document.elementFromPoint(innerWidth / 2, innerHeight - 30);
        return (
          stage.contains(panelPoint) &&
          stage.contains(composerPoint) &&
          getComputedStyle(stage).boxShadow !== "none"
        );
      }),
      "preview and subtle shadow sit above the right panel and composer"
    );
  };
  try {
    for (const theme of ["light", "dark"]) {
      phase = theme + " controls";
      await load("theme=" + theme);
      await openDetails();
      const close = p.getByRole("button", { name: "Close details", exact: true });
      const r = await rect(close);
      check(
        r.x === 1408 && r.y === 12 && r.width === 36 && r.height === 36,
        "top-right button has exact 12px inset and 36px size"
      );
      check(
        (await close.evaluate((e) => getComputedStyle(e).borderWidth)) === "1px",
        "top-right button includes reference border"
      );
      await close.screenshot({ path: out + "/ours-close-" + theme + ".png" });
      await p
        .getByRole("button", { name: "View conversation details", exact: true })
        .first()
        .click();
      await pause(350);
      check(!(await close.isVisible()), "title pill toggles the panel closed");
      await openDetails();
      phase = theme + " Library files";
      await p.getByRole("tab", { name: "Library", exact: true }).click();
      const file = p.getByRole("button", { name: "sales_summary.xlsx", exact: true });
      await file.waitFor();
      check(
        (await rect(p.locator(".bot-library-row").first())).height === 36,
        "Library file row is 36px"
      );
      await file.hover();
      await p
        .getByRole("button", { name: "More actions for sales_summary.xlsx", exact: true })
        .click();
      const menu = p.getByRole("menu");
      await menu.waitFor();
      await pause(300);
      const menuRect = await rect(menu);
      check(
        menuRect.x === 1271 &&
          menuRect.y === 307 &&
          menuRect.width === 160 &&
          menuRect.height === 44,
        "Library menu matches reference position and dimensions"
      );
      await p.keyboard.press("Escape");
      await pause(150);
      await file.click();
      await p.locator("[role=dialog] table").waitFor();
      await checkStage();
      check(
        (await p.getByRole("dialog").innerText()).includes("January"),
        "spreadsheet preview renders its content"
      );
      await p.screenshot({ path: out + "/ours-workbook-" + theme + ".png" });
      await p.keyboard.press("Escape");
      await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
      check(await close.isVisible(), "closing preview restores the open details panel");
      await checkFocus(file, "closing returns focus to the file");
      phase = theme + " Library images";
      await load("theme=" + theme + "&media=single&library=images");
      await openDetails();
      await p.getByRole("tab", { name: "Library", exact: true }).click();
      const image = p.getByRole("button", { name: "image-0.png", exact: true });
      await image.waitFor();
      await p.locator(".bot-library-thumbnail img").waitFor();
      check(
        (await rect(p.locator(".bot-library-thumbnail img").first())).width === 20,
        "Library image uses a 20px photo thumbnail"
      );
      check(
        (await rect(p.locator("[data-image-tile]").first())).height === 200,
        "single inline photo matches current 200px reference height"
      );
      const editor = p.getByRole("textbox", { name: "Message", exact: true });
      await editor.fill("A longer draft\nSecond line\nThird line");
      await image.click();
      await p.locator("[data-media-viewer] .media-stage-cell img").waitFor();
      await checkStage();
      check(
        (await p.locator(".attachment-stage-title").innerText()) === "image-0.png" &&
          (await p.locator(".media-stage-caption").innerText()) === "image-0.png",
        "Library image title and caption use filename"
      );
      check(
        (await p.locator("[data-attachment-stage]").getAttribute("data-attachment-tone")) ===
          "dark",
        "media sheet uses its dark viewer tone in both app themes"
      );
      await p.getByRole("button", { name: "Close media preview", exact: true }).focus();
      await p.keyboard.press("Shift+Tab");
      check(
        await p
          .locator("[data-attachment-stage]")
          .evaluate((e) => e.contains(document.activeElement)),
        "keyboard focus stays inside the modal preview"
      );
      const caption = await rect(p.locator(".media-stage-caption"));
      check(caption.bottom < p.viewportSize().height - 8, "caption fits within the sheet");
      await p.keyboard.press("Escape");
      await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
      check(
        (await editor.innerText()) === "A longer draft\nSecond line\nThird line",
        "closing preview preserves unsent draft"
      );
      phase = theme + " gallery";
      await load("theme=" + theme + "&media=twenty");
      await p.locator("[data-image-tile] button").first().click();
      await p.locator("[data-media-filmstrip] button").last().waitFor();
      await pause(250);
      check(
        (await p.evaluate(() => new Set(window.visualAssetFetches).size)) <= 10,
        "opening 20 images fetches only visible thumbnails and a small prefetch margin"
      );
      check(
        (await p.locator("[data-media-filmstrip] button").count()) === 20,
        "all 20 media thumbnails are available"
      );
      check(
        (await rect(p.locator("[data-media-filmstrip]"))).width === 440,
        "filmstrip viewport matches 440px reference"
      );
      await p.getByRole("button", { name: "Close media preview", exact: true }).focus();
      for (let i = 0; i < 15; i++) await p.keyboard.press("ArrowRight");
      await pause(350);
      await p.getByRole("button", { name: "View media 16 of 20", exact: true }).waitFor();
      check(
        (await p
          .getByRole("button", { name: "View media 16 of 20", exact: true })
          .getAttribute("aria-current")) === "true",
        "arrow keys select the next media"
      );
      check(
        (await p.locator("[data-media-filmstrip]").evaluate((e) => e.scrollLeft)) > 0,
        "active thumbnail scrolls into view"
      );
      await p.screenshot({ path: out + "/ours-gallery-" + theme + ".png" });
      await p.keyboard.press("Escape");
    }
    phase = "eight-image gallery";
    await load("theme=dark&media=multi");
    await p.locator("[data-image-tile] button").first().click();
    await p.locator("[data-media-filmstrip] button").last().waitFor();
    check(
      (await p.locator("[data-media-filmstrip] button").count()) === 8,
      "eight-image gallery retains every thumbnail"
    );
    check(
      (await p
        .locator("[data-media-filmstrip]")
        .evaluate((element) => getComputedStyle(element).maskImage)) === "none",
      "filmstrip does not fade thumbnails when they all fit"
    );
    phase = "media download filename";
    await load("theme=light&media=single");
    await p.locator("[data-image-tile] button").first().click();
    await p.locator(".media-stage-cell img").waitFor();
    await p.evaluate(() => {
      window.mediaDownload = null;
      HTMLAnchorElement.prototype.click = function () {
        window.mediaDownload = { name: this.download, url: this.href };
      };
    });
    await p.getByRole("button", { name: "Download media", exact: true }).click();
    check(
      (await p.evaluate(() => window.mediaDownload?.name)) === "image-0.png",
      "image download retains the actual filename instead of its descriptive caption"
    );
    phase = "narrow viewer";
    await load("theme=light&media=single", 760);
    await p.locator("[data-image-tile] button").first().click();
    await checkStage();
    check((await rect(p.locator(".media-stage-cell img"))).right <= 760, "image fits narrow stage");
    await p.screenshot({ path: out + "/ours-narrow-media.png" });
    for (const mode of ["slow", "broken", "missing"]) {
      phase = mode + " image";
      await load("theme=dark&media=" + mode);
      await p.locator("[data-image-tile] button").first().click();
      if (mode === "slow") {
        await p
          .getByText("Loading image…", { exact: true })
          .or(p.locator(".media-stage-cell img"))
          .first()
          .waitFor();
        await p.locator(".media-stage-cell img").waitFor();
        check(
          await p
            .locator(".media-stage-cell img")
            .evaluate((e) => e.complete && e.naturalWidth > 0),
          "slow image finishes loading"
        );
      } else {
        await p.getByText("This image couldn’t be loaded.", { exact: true }).waitFor();
        check(
          (await p.locator(".media-stage-cell img").count()) === 0,
          "failed image has no broken-image glyph or clipped alt text"
        );
      }
      await p.screenshot({ path: out + "/ours-" + mode + "-image.png" });
    }
    phase = "navigation";
    await load("theme=light&media=single&navigation");
    await p.locator("[data-image-tile] button").first().click();
    await p
      .getByRole("button", { name: /Other bot/, includeHidden: true })
      .first()
      .evaluate((e) => e.click());
    await p
      .locator("[data-message-id]")
      .getByText("A different conversation.", { exact: true })
      .waitFor();
    await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
    check(true, "programmatic chat switching closes a warm conversation viewer");
    phase = "file formats";
    await load("theme=light&files");
    for (const name of [
      "bank-transactions-reconciled-v2-2026-11-10.csv",
      "Preview sample.docx",
      "Project notes.txt",
      "Archive.zip",
    ]) {
      await p.getByRole("button", { name: "Open " + name, exact: true }).click();
      await p.getByRole("dialog").waitFor();
      await checkStage();
      await pause(500);
      check(
        !(await p.getByRole("dialog").innerText()).includes("Loading document…"),
        name + " leaves loading state"
      );
      await p.screenshot({ path: out + "/ours-file-" + name.split(".").at(-1) + ".png" });
      await p.keyboard.press("Escape");
      await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
    }
    phase = "sheet motion";
    await load("theme=light&files");
    const file = p.getByRole("button", { name: "Open Project notes.txt", exact: true });
    await file.click();
    const motion = await p.locator("[data-attachment-stage]").evaluate(async (stage) => {
      const animation = stage.getAnimations()[0];
      if (!animation) return null;
      animation.pause();
      animation.currentTime = 0;
      await new Promise(requestAnimationFrame);
      const start = stage.getBoundingClientRect().top;
      animation.currentTime = 140;
      await new Promise(requestAnimationFrame);
      const middle = stage.getBoundingClientRect().top;
      animation.finish();
      return { start, middle, height: innerHeight };
    });
    check(
      motion && motion.start >= motion.height && motion.middle > 8 && motion.middle < motion.start,
      "sheet enters from below the window and moves upward"
    );
    await checkStage();
    await p.getByRole("button", { name: "Close preview", exact: true }).click();
    await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
    await checkFocus(file, "close button restores file focus");
    phase = "interrupted sheet entry";
    await file.click();
    const interruption = await p.locator("[data-attachment-stage]").evaluate(async (stage) => {
      const entry = stage.getAnimations()[0];
      entry.pause();
      entry.currentTime = 45;
      await new Promise(requestAnimationFrame);
      const before = stage.getBoundingClientRect().y;
      stage.querySelector("button").click();
      await new Promise(requestAnimationFrame);
      const exit = stage.getAnimations()[0];
      exit.pause();
      exit.currentTime = 0;
      await new Promise(requestAnimationFrame);
      const after = stage.getBoundingClientRect().y;
      exit.play();
      return { before, after };
    });
    check(
      interruption.before > 100 && Math.abs(interruption.after - interruption.before) < 1,
      "dismissing during entry continues from its current position without jumping"
    );
    await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
    phase = "reduced-motion sheet";
    await p.emulateMedia({ reducedMotion: "reduce" });
    await file.click();
    await checkStage();
    check(
      await p
        .locator("[data-attachment-stage]")
        .evaluate((e) => getComputedStyle(e).animationName === "none"),
      "reduced-motion preference disables sheet animation"
    );
    await p.keyboard.press("Escape");
    await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
    await p.emulateMedia({ reducedMotion: "no-preference" });
    phase = "macOS window controls";
    await load("theme=light&files", 512);
    await p.evaluate(() => {
      window.openteam = { platform: "darwin" };
    });
    await file.click();
    await checkStage();
    const closePreview = await rect(p.getByRole("button", { name: "Close preview", exact: true }));
    const title = await rect(p.locator(".attachment-stage-title"));
    const download = await rect(p.getByRole("button", { name: "Download file", exact: true }));
    check(
      // Traffic lights sit at x 16, y 15 and end near (68, 27): clear them below or to the right.
      (closePreview.y >= 30 || closePreview.x >= 96) &&
        closePreview.right <= title.x &&
        title.right < download.x &&
        download.right <= 512,
      "preview controls clear native macOS traffic lights and fit at the minimum window width"
    );
    await p.locator(".attachment-stage-backdrop").click({ position: { x: 1, y: 1 } });
    await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
    await checkFocus(file, "clicking the backdrop restores file focus");
    check(!errors.length, "no renderer errors");
    fs.writeFileSync(
      out + "/native-interactions.json",
      JSON.stringify({ checks, errors }, null, 2)
    );
    console.log("Passed " + checks.length + " native checks");
  } catch (e) {
    await p.screenshot({ path: out + "/native-failure.png" });
    fs.writeFileSync(
      out + "/native-interactions.json",
      JSON.stringify({ phase, error: String(e), checks, errors }, null, 2)
    );
    throw e;
  } finally {
    await b.close();
  }
};

if (require.main === module)
  module
    .exports({ port: Number(process.argv[2]), url: process.argv[3], out: process.argv[4] })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
