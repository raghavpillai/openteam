import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";
const require = createRequire(import.meta.url);
const output = resolve(import.meta.dir, "../../../output/onepassword-parity");
await mkdir(output, { recursive: true });
const server = await createServer({ root: resolve(import.meta.dir, ".."), configFile: resolve(import.meta.dir, "../vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
try {
  await server.listen();
  for (const mode of ["settings", "marketplace"]) {
  const modeOutput = resolve(output, mode);
  await mkdir(modeOutput, { recursive: true });
  const child = Bun.spawn([require("electron"), resolve(import.meta.dir, "../test/browser/saved-login-settings-runner.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SAVED_LOGIN_TEST_OUTPUT: modeOutput, SAVED_LOGIN_TEST_URL: `${server.resolvedUrls!.local[0]}test/browser/saved-login-settings.html${mode === "marketplace" ? "?marketplace=1" : ""}` }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`Saved-login UI fixture failed: ${stderr}\n${stdout}`);
  console.log(`${mode}: ${await readFile(resolve(modeOutput, "results.json"), "utf8")}`);
  }
} finally { await server.close(); }
