import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-send-motion-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
try {
  await server.listen();
  const child = Bun.spawn(
    [
      require("electron") as string,
      resolve(import.meta.dir, "../test/browser/message-send-motion-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        MESSAGE_MOTION_DIR: directory,
        MESSAGE_MOTION_URL: `${server.resolvedUrls!.local[0]}test/browser/message-send-motion.html${process.argv.includes("--legacy") ? "?legacy" : ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 90_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Electron failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (result.error) throw new Error(result.error);
  if (
    result.reports.some(
      (report: { starts: number; sameNode: boolean; maxLayoutJump?: number }) =>
        report.starts !== 1 || !report.sameNode || (report.maxLayoutJump ?? 0) > 1
    )
  )
    throw new Error("Messages must enter once, retain their bubble, and stay still when thinking exits");
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
