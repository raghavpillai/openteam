const { app, BrowserWindow, nativeImage, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const directory = process.env.LINK_FAVICONS_DIR;
app.setPath("userData", path.join(directory, "profile"));
protocol.registerSchemesAsPrivileged([{ scheme: "openteam-favicon", privileges: { standard: true, secure: true } }]);

// A 32px rounded tile in one color, standing in for a site's icon.
const tile = (r, g, b) => {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(Math.max(0, Math.abs(x - 15.5) - 9), Math.max(0, Math.abs(y - 15.5) - 9)) < 7;
      const mark = Math.abs(x - 15.5) < 3 && y > 8 && y < 24;
      const i = (y * size + x) * 4;
      // Bitmaps are BGRA.
      pixels[i] = mark ? 255 : b;
      pixels[i + 1] = mark ? 255 : g;
      pixels[i + 2] = mark ? 255 : r;
      pixels[i + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG();
};
const slowIcon = tile(230, 110, 40);
const icons = { "fast.example": tile(51, 102, 204), "slow-light.example": slowIcon, "slow-dark.example": slowIcon };
const requests = [];

app.whenReady().then(async () => {
  protocol.handle("openteam-favicon", async (request) => {
    const host = decodeURIComponent(new URL(request.url).pathname.slice(1));
    requests.push(host);
    if (host.startsWith("slow-")) await new Promise((resolve) => setTimeout(resolve, 1500));
    const icon = icons[host];
    return icon
      ? new Response(icon, { headers: { "content-type": "image/png" } })
      : new Response(null, { status: 404 });
  });
  const win = new BrowserWindow({ show: false, width: 620, height: 340, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  const evaluate = (expression) => win.webContents.executeJavaScript(expression);
  const capture = async (name) =>
    fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const results = {};
  try {
    for (const theme of ["light", "dark"]) {
      // A fresh page and HTTP cache per theme, so each starts without icons.
      await win.webContents.session.clearCache();
      await win.loadURL(process.env.LINK_FAVICONS_URL);
      await evaluate("new Promise(resolve => { const check = () => window.renderLinks ? resolve() : setTimeout(check, 25); check(); })");
      const loading = await evaluate(`renderLinks(${JSON.stringify(theme)})`);
      await capture(`${theme}-loading`);
      const settled = await evaluate("settle()");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await capture(`${theme}-settled`);
      // Hovering a link shows its address card above it.
      const label = await evaluate(`(() => { const r = document.querySelector('.link-label').getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
      win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(label.x), y: Math.round(label.y) });
      await new Promise((resolve) => setTimeout(resolve, 600));
      const hover = await evaluate(`(() => { const card = document.querySelector('.link-hover-preview[data-visible]'); if (!card) return null; const r = card.getBoundingClientRect(); const l = document.querySelector('.link-label').getBoundingClientRect(); return { card: [r.x, r.y, r.width, r.height], label: [l.x, l.y, l.width, l.height], text: card.textContent }; })()`);
      await capture(`${theme}-hover`);
      win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 290 });
      results[theme] = { loading, settled, hover };
    }
    results.requests = requests;
  } catch (error) {
    results.error = String(error?.stack ?? error);
  }
  fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(results, null, 2));
  app.quit();
});
