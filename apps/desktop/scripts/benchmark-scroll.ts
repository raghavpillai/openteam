import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build, preview } from "vite";

// Frozen production bundles; baseline overrides never modify workspace sources.
const require = createRequire(import.meta.url);
const output = resolve(
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
    resolve(import.meta.dir, "../../../output/chat-scroll-performance")
);
const root = resolve(import.meta.dir, "..");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11);
if (!baseline) throw Error("Supply --baseline=<directory with the saved pre-fix modules>");
const originals = {
  "src/renderer/components/openteam/virtualized-timeline.tsx": "virtualized-timeline-before.tsx",
  "src/renderer/components/openteam/thread-tray.tsx": "thread-tray-before.tsx",
  "src/renderer/components/openteam/chat-pane.tsx": "chat-pane-before.tsx",
  "src/renderer/lib/thread-pin.ts": "thread-pin-before.ts",
};
await mkdir(output, { recursive: true });
if (!process.argv.includes("--skip-build")) {
  for (const arm of ["before", "after"]) {
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "production",
      logLevel: "warn",
      plugins:
        arm === "before"
          ? [
              {
                name: "scroll-performance-control",
                enforce: "pre",
                load(id) {
                  const source = Object.entries(originals).find(
                    ([file]) => resolve(root, file) === id
                  )?.[1];
                  if (source) return readFile(resolve(baseline, source), "utf8");
                },
              },
            ]
          : [],
      build: {
        outDir: join(output, arm),
        emptyOutDir: true,
        rolldownOptions: { input: join(root, "test/browser/scroll-stress.html") },
      },
    });
  }
}
if (!process.argv.includes("--prepare-only")) {
  const servers = [];
  try {
    for (const arm of ["before", "after"])
      servers.push(
        await preview({
          root,
          configFile: join(root, "vite.config.ts"),
          build: { outDir: join(output, arm) },
          preview: { port: 0, strictPort: false, host: "127.0.0.1" },
        })
      );
    const runner = await readFile(join(root, "test/browser/scroll-performance-runner.cjs"), "utf8");
    const configuration = {
      output,
      urls: Object.fromEntries(
        servers.map((server, index) => [
          index ? "after" : "before",
          server.resolvedUrls!.local[0] + "test/browser/scroll-stress.html",
        ])
      ),
    };
    await writeFile(
      join(output, "performance-main.cjs"),
      `const configuration=${JSON.stringify(configuration)};\n` + runner
    );
    const child = Bun.spawn([require("electron") as string, join(output, "performance-main.cjs")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdout: "inherit",
      stderr: "inherit",
    });
    const timer = setTimeout(() => child.kill(), 600_000);
    const code = await child.exited;
    clearTimeout(timer);
    if (code) throw Error(`Performance runner exited ${code}`);
    const samples = JSON.parse(await readFile(join(output, "desktop-samples.json"), "utf8"));
    if (samples.length !== 24) throw Error(`Incomplete benchmark: ${samples.length}/24 samples`);
  } finally {
    for (const server of servers)
      await new Promise<void>((done) => server.httpServer.close(() => done()));
  }
}
