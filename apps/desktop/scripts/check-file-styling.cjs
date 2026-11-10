// Run against Vite: node scripts/check-file-styling.cjs [url] [artifact directory]
const path = require("node:path"),
  fs = require("node:fs");
// Reuse the browser runtime already declared by the computer workspace.
const { createRequire } = require("node:module");
const { chromium } = createRequire(path.resolve(__dirname, "../../computer/package.json"))(
  "playwright-core"
);
const base = process.argv[2] || "http://127.0.0.1:5176";
const dir = path.resolve(
  process.argv[3] || path.join(__dirname, "../../../artifacts/desktop-style-review/files")
);
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1176, height: 924 },
      deviceScaleFactor: 2,
      recordVideo: { dir, size: { width: 1176, height: 924 } },
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/test/browser/desktop-style-review.html?files`);
    await page.waitForLoadState("networkidle");
    const cards = page.locator("[data-file-attachment-card]");
    await cards.first().waitFor();
    const geometry = await cards.evaluateAll((es) =>
      es.map((e) => ({
        width: e.getBoundingClientRect().width,
        height: e.getBoundingClientRect().height,
        radius: getComputedStyle(e).borderRadius,
      }))
    );
    if (
      geometry.length !== 7 ||
      geometry.some((x) => x.width !== 354 || x.height !== 72 || x.radius !== "22px")
    )
      throw Error(`Card geometry: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: path.join(dir, "cards.png") });
    await cards.first().screenshot({ path: path.join(dir, "first-card.png") });
    const pill = page.getByRole("button", { name: "View conversation details", exact: true });
    await pill.hover();
    await page.waitForTimeout(160);
    const hover = await page.locator(".desktop-conversation-chevron").evaluate((e) => ({
      opacity: getComputedStyle(e).opacity,
      transform: getComputedStyle(e).transform,
      duration: getComputedStyle(e).transitionDuration,
    }));
    if (hover.opacity !== "1") throw Error("Header chevron did not reveal");
    await page.screenshot({ path: path.join(dir, "header-hover.png") });
    const csv = page.getByRole("button", {
      name: "Open bank-transactions-reconciled-v2-2026-11-10.csv",
      exact: true,
    });
    await csv.hover();
    await page.waitForTimeout(160);
    await page.screenshot({ path: path.join(dir, "card-hover.png") });
    await csv.click();
    await page.screenshot({ path: path.join(dir, "after-open.png") });
    await page.locator(".openteam-table-preview td").first().waitFor();
    await page.screenshot({ path: path.join(dir, "csv-preview.png") });
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByRole("button", { name: "Open Preview sample.docx", exact: true }).click();
    await page
      .locator(".openteam-document-preview")
      .filter({ hasText: "A neutral document" })
      .waitFor();
    await page.screenshot({ path: path.join(dir, "docx-preview.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open Project notes.txt", exact: true }).click();
    await page.locator("pre").filter({ hasText: "A neutral file" }).waitFor();
    await page.screenshot({ path: path.join(dir, "text-preview.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open Design.key", exact: true }).click();
    await page.getByText("Preview not available", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 760, height: 924 });
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    await page.waitForTimeout(350);
    if (await cards.first().evaluate((e) => e.getBoundingClientRect().right > innerWidth))
      throw Error("Attachment overflows narrow viewport");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pill.hover();
    fs.writeFileSync(
      path.join(dir, "checks.json"),
      JSON.stringify(
        {
          geometry,
          hover,
          errors,
          checks: [
            "CSV grid",
            "DOCX document",
            "text",
            "native unsupported-file fallback",
            "header hover",
            "narrow layout",
            "reduced motion",
          ],
        },
        null,
        2
      )
    );
    if (errors.length) throw Error(errors.join("\n"));
    console.log(
      "PASS: file cards, CSV/DOCX/text previews, native-file fallback, hover, narrow layout and reduced motion"
    );
    await ctx.close();
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
