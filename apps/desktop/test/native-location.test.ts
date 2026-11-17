import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
let electron: string | undefined;
try { electron = require("electron"); } catch { /* Electron's install script may not have run. */ }

test.if(process.platform === "darwin" && !!electron && existsSync(electron))(
  "the macOS native bridge handles success, refusal, unavailability, timeout, and retry",
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "openteam-location-test-"));
    try {
      const modulePath = resolve(directory, "location.node");
      const compile = Bun.spawn([
        "xcrun", "clang", "-fobjc-arc", "-shared", "-undefined", "dynamic_lookup",
        "-DNAPI_VERSION=8", "-I", resolve(dirname(require.resolve("node-api-headers/package.json")), "include"),
        "-framework", "Foundation", "-framework", "CoreLocation",
        resolve(import.meta.dir, "fixtures/location-manager.m"), "-o", modulePath,
      ], { stdout: "pipe", stderr: "pipe" });
      const errors = await new Response(compile.stderr).text();
      expect(await compile.exited, errors).toBe(0);
      const runner = resolve(directory, "runner.cjs");
      await writeFile(runner, `
const { app } = require("electron");
const assert = require("node:assert/strict");
app.whenReady().then(async () => {
  const native = require(${JSON.stringify(modulePath)});
  for (const [mode, code] of [["success", 0], ["denied", 1], ["deny-prompt", 1], ["unavailable", 2], ["timeout", 3], ["stale", 3], ["success", 0]]) {
    process.env.OPENTEAM_LOCATION_TEST_MODE = mode;
    const result = await native.readPosition(50);
    assert.equal(result.code, code, mode);
    if (!code) {
      assert.equal(result.latitude, 12.5);
      assert.equal(result.longitude, -45.5);
      assert.equal(result.accuracy, 25);
      assert.ok(Math.abs(Date.now() - result.timestamp) < 2000);
    }
  }
  console.log("native-location: ok");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
      const child = Bun.spawn([electron!, runner], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout).toContain("native-location: ok");
      } finally { clearTimeout(timer); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000,
);
