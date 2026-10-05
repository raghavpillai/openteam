import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-image-layout-"));
const conversation = process.argv.includes("--conversation");
const navigation = process.argv.includes("--navigation");
const rendererFailureArgument = process.argv.find(
  (arg) => arg === "--renderer-failure" || arg.startsWith("--renderer-failure=")
);
const rendererFailure = rendererFailureArgument
  ? (rendererFailureArgument.split("=")[1] ?? "markdown")
  : undefined;
if (rendererFailure && !conversation) throw new Error("Renderer failures require --conversation");
if (rendererFailure && !["markdown", "plugin", "file"].includes(rendererFailure))
  throw new Error("Unknown renderer failure mode");
const withoutRendererBoundary = process.argv.includes("--without-renderer-boundary");
if (withoutRendererBoundary && !rendererFailure) throw new Error("Boundary control requires an injected failure");
// An audit control can replace only these production modules, while executing
// the exact same fixture, dependencies, delays, and assertions as the fixed run.
const control = process.argv.find((arg) => arg.startsWith("--control-dir="))?.slice(14);
if (control && !navigation) throw new Error("Source controls require --navigation");
const controlFiles = new Set([
  "src/renderer/state/use-openteam.ts",
  "src/renderer/components/openteam/chat-pane.tsx",
  "src/renderer/components/openteam/thread-tray.tsx",
]);
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  cacheDir: join(directory, "vite-cache"),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
  plugins:
    conversation || navigation
      ? [
          {
            name: "navigation-audit-control",
            enforce: "pre" as const,
            async load(id: string) {
              const path = relative(resolve(import.meta.dir, ".."), id.split("?")[0]!);
              if (withoutRendererBoundary && path === "src/renderer/components/ai-elements/message.tsx") {
                const source = await readFile(id.split("?")[0]!, "utf8");
                const handler = "  static getDerivedStateFromError() {\n    return { failed: true };\n  }\n";
                if (!source.includes(handler)) throw new Error("Renderer boundary control no longer matches");
                return source.replace(handler, "");
              }
              if (control && controlFiles.has(path))
                return readFile(resolve(control, path), "utf8");
              if (
                rendererFailure === "markdown" &&
                path === "src/renderer/components/ai-elements/message-response.tsx"
              ) {
                return 'throw new Error("Injected renderer import failure"); export default function Renderer() {}';
              }
              if (
                rendererFailure === "plugin" &&
                path === "src/renderer/components/ai-elements/message-response/code.ts"
              ) {
                return 'throw new Error("Injected code plugin failure"); export const code = {};';
              }
              if (
                rendererFailure === "file" &&
                path === "src/renderer/components/openteam/file-attachment.tsx"
              ) {
                return 'throw new Error("Injected file renderer failure"); export function MessageFileAttachments() {}';
              }
            },
          },
          {
            name: "delay-chat-renderers",
            configureServer(server) {
              server.middlewares.use((request, _response, next) => {
                if (
                  /\/message-response(?:\/rich)?\.tsx|\/file-attachment\.tsx/.test(
                    request.url ?? ""
                  )
                ) {
                  setTimeout(next, 700);
                } else next();
              });
            },
          },
        ]
      : [],
});
try {
  await server.listen();
  const runner = join(directory, "main.cjs");
  await writeFile(
    runner,
    `
    const {app, BrowserWindow} = require('electron');
    const fs = require('node:fs');
    app.setPath('userData', ${JSON.stringify(join(directory, "profile"))});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({show: false, width: 920, height: 740,
        webPreferences: {backgroundThrottling: false}});
      win.webContents.on('console-message', event => {
        if (event.message.startsWith('IMAGE_LAYOUT_RESULT ')) {
          fs.writeFileSync(${JSON.stringify(join(directory, "results.json"))},
            event.message.slice('IMAGE_LAYOUT_RESULT '.length));
          app.quit();
        }
      });
      await win.loadURL(${JSON.stringify(`${server.resolvedUrls!.local[0]}test/browser/${navigation ? "navigation-startup.html" : `${conversation ? "initial-conversation" : "image-attachment"}-layout.html`}${rendererFailure ? `?rendererFailure=${rendererFailure}` : ""}`)});
    }).catch(error => {console.error(error); app.exit(1)});
  `
  );
  const child = Bun.spawn([require("electron") as string, runner], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      child.kill();
    },
    conversation ? 180_000 : navigation ? 120_000 : 60_000
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (timedOut) throw new Error(`Layout suite timed out: ${stderr}`);
  if (code) throw new Error(`Electron failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  for (const report of result.reports ?? []) console.log(`PASS ${report}`);
  if (result.error) throw new Error(`${result.error}\n${result.stack ?? ""}`);
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
