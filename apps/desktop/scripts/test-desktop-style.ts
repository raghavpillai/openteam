import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "desktop-style",
  runner: "desktop-style-runner.cjs",
  page: "desktop-style-app.html",
  env: (dir, url) => ({ DESKTOP_STYLE_DIR: dir, DESKTOP_STYLE_URL: url }),
  timeoutMs: 70_000,
  vite: { optimizeDeps: { include: ["xlsx", "mammoth"] } },
});
