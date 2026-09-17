import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? resolve(root, "../../output/performance/code-rendering"));
await mkdir(output, { recursive: true });
await build({ root, configFile: resolve(root,"vite.config.ts"), logLevel: "error", build: { outDir: resolve(output,"dist"), emptyOutDir: true, rolldownOptions: { input: resolve(root,"test/browser/code-rendering.html") } } });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = resolve(output,"dist", "."+new URL(request.url).pathname);
  if(!path.startsWith(resolve(output,"dist")+"/"))return new Response(null,{status:403});
  const file = Bun.file(path);return await file.exists() ? new Response(file) : new Response(null,{status:404});
} });
try {
  const electron = createRequire(import.meta.url)("electron") as string;
  const process = Bun.spawn([electron, resolve(root,"test/browser/code-rendering-runner.cjs")], {
    env: { ...Bun.env, ELECTRON_RUN_AS_NODE: undefined, CODE_TEST_OUTPUT: output, CODE_TEST_URL: new URL("test/browser/code-rendering.html",server.url).href },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => process.kill(), 60_000);
  const [status, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  clearTimeout(timer);
  const result = JSON.parse(await readFile(resolve(output,"results.json"),"utf8"));
  if(status!==0 || result.error)throw Error(JSON.stringify(result)+"\n"+stdout+stderr);
  for(const report of result.reports)console.log("PASS",JSON.stringify(report));
} finally { server.stop(true); }
