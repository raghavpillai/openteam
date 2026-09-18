import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dir, "..");
const output = resolve(
  process.argv[2] ?? resolve(root, "../../output/performance/authenticated-assets")
);
await mkdir(output, { recursive: true });
await build({
  root,
  configFile: resolve(root, "vite.config.ts"),
  logLevel: "error",
  build: {
    outDir: resolve(output, "dist"),
    emptyOutDir: true,
    rolldownOptions: { input: resolve(root, "test/browser/authenticated-assets.html") },
  },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const route = new URL(request.url).pathname;
    const user = { id: "qa", name: "QA", username: "qa", email: "qa@example.test" };
    if (route === "/api/auth/config") return Response.json({ mode: "required" });
    if (route === "/api/auth/login")
      return Response.json({ user }, { headers: { "set-auth-token": "fixture-token" } });
    if (route === "/api/auth/get-session") return Response.json({ session: { id: "qa" }, user });
    if (/^\/api\/(v0\/)?assets\//.test(route)) {
      if (request.headers.get("authorization") !== "Bearer fixture-token")
        return new Response(null, { status: 401 });
      if (route.endsWith("a".repeat(64)))
        return new Response(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=",
            "base64"
          ),
          { headers: { "content-type": "image/png" } }
        );
      return new Response("# Authenticated file content", {
        headers: { "content-type": "text/markdown" },
      });
    }
    const path = resolve(output, "dist", "." + new URL(request.url).pathname);
    if (!path.startsWith(resolve(output, "dist") + "/")) return new Response(null, { status: 403 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});
try {
  const electron = createRequire(import.meta.url)("electron") as string;
  const process = Bun.spawn(
    [electron, resolve(root, "test/browser/authenticated-assets-runner.cjs")],
    {
      env: {
        ...Bun.env,
        ELECTRON_RUN_AS_NODE: undefined,
        ASSET_TEST_OUTPUT: output,
        ASSET_TEST_URL: new URL("test/browser/authenticated-assets.html", server.url).href,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => process.kill(), 60_000);
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  clearTimeout(timer);
  if (status !== 0) throw Error(stdout + stderr);
  const result = JSON.parse(await readFile(resolve(output, "results.json"), "utf8"));
  if (status !== 0 || result.error) throw Error(JSON.stringify(result) + "\n" + stdout + stderr);
  console.log("PASS", JSON.stringify(result));
} finally {
  server.stop(true);
}
