// Offline visual and motion recording; requires Vite on port 5176.
const root = require("node:path").resolve(__dirname, "../../..");
// Reuse the browser runtime already declared by the computer workspace.
const { createRequire } = require("node:module");
const { chromium } = createRequire(
  require("node:path").resolve(__dirname, "../../computer/package.json")
)("playwright-core");
const fs = require("fs"),
  path = require("path");
const base = process.argv[2] || "http://127.0.0.1:5176";
const dir = path.join(root, "artifacts/desktop-style-review/theme-motion");
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const c = await b.newContext({
      viewport: { width: 1176, height: 924 },
      deviceScaleFactor: 2,
      recordVideo: { dir, size: { width: 1176, height: 924 } },
    });
    const p = await c.newPage();
    const metrics = [];
    for (const theme of ["light", "dark"]) {
      await p.goto(`${base}/test/browser/desktop-style-review.html?theme=${theme}`);
      await p.waitForLoadState("networkidle");
      await p.locator(".bot-markdown a").first().waitFor();
      await p.screenshot({ path: path.join(dir, `${theme}.png`) });
      metrics.push({
        theme,
        bubbles: await p.locator(".message-bubble").evaluateAll((es) =>
          es.slice(0, 2).map((e) => {
            const s = getComputedStyle(e);
            return {
              color: s.color,
              background: s.backgroundColor,
              gradient: s.backgroundImage,
              shadow: s.boxShadow,
            };
          })
        ),
      });
      await p.goto(`${base}/test/browser/desktop-style-review.html?files&theme=${theme}`);
      await p.waitForLoadState("networkidle");
      await p.screenshot({ path: path.join(dir, `${theme}-files.png`) });
      metrics.at(-1).fileShadow = await p
        .locator("[data-file-attachment-card]")
        .first()
        .evaluate((e) => getComputedStyle(e).boxShadow);
    }
    fs.writeFileSync(path.join(dir, "themes.json"), JSON.stringify(metrics, null, 2));
    if (process.argv[3] === "themes-only") {
      await c.close();
      return;
    }
    const result = new Promise((resolve) =>
      p.on("console", (msg) => {
        if (msg.text().startsWith("MESSAGE_MOTION_RESULT "))
          resolve(JSON.parse(msg.text().slice(22)));
      })
    );
    await p.goto(`${base}/test/browser/message-send-motion.html`);
    const r = await result;
    fs.writeFileSync(path.join(dir, "recorded-motion-results.json"), JSON.stringify(r, null, 2));
    console.log(
      JSON.stringify({
        error: r.error,
        scenarios: r.reports?.length,
        allEnterOnce: r.reports?.every((x) => x.starts === 1),
        allRetained: r.reports?.every((x) => x.sameNode),
      })
    );
    if (
      r.error ||
      r.reports?.length !== 48 ||
      r.reports.some(
        (report) => report.starts !== 1 || !report.sameNode || (report.maxLayoutJump ?? 0) > 1
      )
    ) {
      throw new Error(r.error || "Message motion regression");
    }
    await c.close();
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
