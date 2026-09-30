import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserUseSession } from "../src/browser/use";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
import { NativeToolExecutor } from "../src/native-tool-executor";
const executablePath = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executablePath) throw Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE");
const root = await mkdtemp(join(tmpdir(), "browser-output-live-"));
await chmod(root, 0o755);
const driver = await outOfProcessPlaywright();
let context: any, session: BrowserUseSession | undefined;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<!doctype html><title>Large observation fixture</title><button>Small control</button>', { headers: { "content-type": "text/html" } }) });
try {
  const profile = join(root, "profile");
  context = await driver.playwright.chromium.launchPersistentContext(profile, { headless: true, executablePath, args: ["--remote-debugging-port=0"] });
  const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
  session = await BrowserUseSession.connect(`http://127.0.0.1:${port}`, join(root, "artifacts"), false);
  const small = await session.execute("browser_navigate", { url: server.url.href });
  assert.ok(JSON.stringify(small.content).includes("Small control"));
  const expected = "🧭 café\n".repeat(20000) + "END-OF-RESULT";
  const result = await session.execute("browser_cdp", { method: "Runtime.evaluate", params: { expression: JSON.stringify(expected), returnByValue: true } });
  const text = result.content.filter(p => p.type === "text").map(p => p.text).join("\n");
  assert.ok(Buffer.byteLength(text) < 10000);
  const path = text.match(/^Large browser output saved to: (.+) \(\d+ bytes\)/)?.[1];
  assert.ok(path, "full result file is identified");
  const full = await readFile(path, "utf8");
  const reader = new NativeToolExecutor({ agentDir: join(root, "runtime"), controlToken: "fixture" });
  const readResult = await reader.read({ path, offset: 1, limit: 5 }, root);
  assert.ok(JSON.stringify(readResult.content).includes("Ran CDP Runtime.evaluate"), "agent Read can open the generated observation");
  assert.ok(full.includes("END-OF-RESULT"), "tail beyond the previous 100k cutoff survives");
  assert.equal((result.details.result as any).result.value, expected);
  assert.ok(!full.includes("browser output truncated"));
  console.log(JSON.stringify({status:"pass",originalBytes:Buffer.byteLength(full),inlineBytes:Buffer.byteLength(text),tailPreserved:true}));
} finally {
  await (session as any)?.browser.close().catch(() => {}); await context?.close(); await driver.stop(); server.stop(true); await rm(root,{recursive:true,force:true});
}
