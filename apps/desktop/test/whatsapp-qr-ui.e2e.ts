/** Real desktop UI, routes, PostgreSQL, MCP and bundled Linux WhatsApp runtime.
 * Only provisions and cancels fresh QR sessions; never approves a phone or sends messages.
 * Requires a disposable DB, the existing Vite fixture, and a local oven/bun:1.4.2 image.
 */
import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPrismaClient } from "../../../packages/db/src";
import { ApiError } from "@openteam/contracts";
import { Effect } from "../../server/node_modules/effect";
import { pluginCatalog } from "../../../packages/plugins/src";
import { StdioMcpManager } from "../../computer/src/mcp-manager";
import { PluginService } from "../../server/src/services/plugin-service";
import { pluginMutationRoutes } from "../../server/src/routes/plugin-mutation";
import { pluginQueryRoutes } from "../../server/src/routes/plugin-query";
import type { AppService } from "../../server/src/app-service";
import { chromium } from "../../computer/node_modules/playwright-core";

if (!process.env.OPENTEAM_TEST_DATABASE_URL || process.env.OPENTEAM_TEST_WHATSAPP_LIVE !== "1")
  throw new Error("Requires a disposable OPENTEAM_TEST_DATABASE_URL and OPENTEAM_TEST_WHATSAPP_LIVE=1 (generates real, unapproved QR codes).");
const output = resolve(process.env.OPENTEAM_TEST_EVIDENCE_DIR ?? "output/whatsapp-qr-evidence");
await mkdir(output, { recursive: true });
const root = await mkdtemp("/tmp/ot-waui-");
const packageRoot = join(root, "plugin");
const definition = pluginCatalog.find(plugin => plugin.key === "whatsapp")!;
for (const [path, content] of Object.entries(definition.files ?? {})) {
  const destination = join(packageRoot, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, content);
}
for (const [path, content] of Object.entries(definition.binaryFiles ?? {})) {
  const destination = join(packageRoot, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, Buffer.from(content, "base64"));
}
const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
const manager = new StdioMcpManager(join(root, "cache"), 30_000);
const containers = new Set<string>();
const runtimeCalls: Array<{ path: string; tool?: string; generation?: number }> = [];
const service = new PluginService(db, async (path, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const id = path.split("/")[4]!;
  const generationHeader = new Headers(init?.headers).get("x-openteam-mcp-generation");
  const generation = body.runtimeGeneration ?? (generationHeader === null ? undefined : Number(generationHeader));
  runtimeCalls.push({ path, tool: body.toolName, generation });
  if (init?.method === "GET") return Response.json(manager.status(id));
  if (init?.method === "DELETE") { await manager.close(id, generation); return Response.json({ ok: true }); }
  const state = join(root, "state", id);
  await mkdir(state, { recursive: true });
  const name = `ot-waui-${id}-${generation ?? 0}`;
  containers.add(name);
  // Run the exact packaged entry point in Linux. No provider simulator or QR override.
  const configuration = {
    command: "docker",
    args: ["run", "--rm", "-i", "--name", name,
      "-v", `${packageRoot}:/plugin:ro`, "-v", `${state}:/state`,
      "--env", `OPENTEAM_PLUGIN_ACCOUNT_ID=${id}`,
      "--env", "OPENTEAM_PLUGIN_STATE_DIR=/state",
      "oven/bun:1.4.2", "bun", "/plugin/connector/server.mjs"],
  };
  if (path.endsWith("/discover"))
    return Response.json({ tools: await manager.discover(id, configuration, generation) });
  return Response.json({ result: await manager.call(id, configuration, body.toolName, body.arguments, generation) });
});
Object.assign(service, {
  catalog: async () => [definition],
  definition: async (key: string) => key === definition.key ? definition : undefined,
});
const app = {
  plugins: service,
  pluginSettings: service.settings,
  pluginConnectionStatuses: service.pollConnectionStatuses,
  installPlugin: service.install,
  disconnectPlugin: service.disconnect,
  restartPluginConnection: service.restart,
} as unknown as AppService;
const requests: Array<{ method: string; path: string; status: number }> = [];
const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v0\//, "/api/");
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" };
  if (request.method === "OPTIONS") return new Response(null, { headers });
  let response: Response;
  try {
    const context = { app, request, url, path, authMode: "disabled" as const, authenticatedSessionId: null };
    response = (await pluginMutationRoutes(context)) ?? (await pluginQueryRoutes(context)) ?? new Response("Not found", { status: 404 });
  } catch (error) {
    response = Response.json({ error: { code: error instanceof ApiError ? error.code : "fixture_error", message: error instanceof Error ? error.message : "Request failed" } }, { status: error instanceof ApiError ? error.status : 500 });
  }
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  requests.push({ method: request.method, path, status: response.status });
  return response;
} });
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 1050 }, recordVideo: { dir: join(output, "video"), size: { width: 1100, height: 1050 } } });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const pageErrors: string[] = [];
page.on("pageerror", error => pageErrors.push(error.message));
const account = () => db.pluginConnection.findFirstOrThrow({ where: { installation: { pluginKey: "whatsapp" } } });
const capture = (file: string) => page.getByRole("dialog").screenshot({ path: join(output, file) });
const showWholeQr = () => page.getByRole("img", { name: "Scan to link your account", exact: true }).evaluate(image => {
  let scroller = image.parentElement;
  while (scroller && getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement;
  if (scroller) scroller.scrollTop += image.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100;
});
let installationId: string | undefined;
try {
  if (await db.pluginInstallation.findUnique({ where: { pluginKey: "whatsapp" } }))
    throw new Error("Refusing to use an existing WhatsApp installation. Use a fresh disposable database.");
  installationId = (await Effect.runPromise(service.install("whatsapp"))).id;
  const ui = process.env.OPENTEAM_TEST_UI_ORIGIN ?? "http://127.0.0.1:63420";
  await page.goto(`${ui}/test/browser/plugin-lifecycle.html?server=${encodeURIComponent(api.url.origin)}&reviewPlugin=whatsapp`);
  await page.getByRole("button", { name: "Open plugin setup", exact: true }).click();
  await page.getByRole("heading", { name: "WhatsApp", exact: true }).waitFor();
  const setup = page.getByRole("region", { name: "Connect WhatsApp", exact: true });
  await setup.waitFor();
  expect(await setup.locator("input, select, textarea").count()).toBe(0);
  expect(await page.getByText("Read-only access", { exact: true }).count()).toBe(0);
  expect(await page.getByText("Attachment folder", { exact: true }).count()).toBe(0);
  expect(await page.getByText("Maximum stored messages", { exact: true }).count()).toBe(0);
  await capture("01-no-parameters.png");
  console.log("PASS: actual WhatsApp setup has zero parameter inputs.");
  await setup.getByRole("button", { name: "Connect", exact: true }).click();
  const qr = page.getByRole("img", { name: "Scan to link your account", exact: true });
  await qr.waitFor();
  await page.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('img[alt="Scan to link your account"]'); return image?.complete && image.naturalWidth > 0; });
  const first = await account();
  const firstLink = (first.credentials as any).deviceLink;
  const firstImage = await qr.getAttribute("src");
  expect(firstLink.qrCodeDataUrl).toBe(firstImage);
  expect(firstLink.expiresAt - Date.now()).toBeGreaterThan(20_000);
  await showWholeQr();
  await capture("02-real-whatsapp-qr.png");
  console.log("PASS: Connect displays a real QR from the bundled wacli runtime in Linux.");
  await page.getByRole("button", { name: "Get new code", exact: true }).click();
  await page.waitForFunction(previous => {
    const image = document.querySelector<HTMLImageElement>('img[alt="Scan to link your account"]');
    return image?.complete && image.naturalWidth > 0 && image.src !== previous;
  }, firstImage);
  await qr.waitFor();
  const replacement = await account();
  const nextLink = (replacement.credentials as any).deviceLink;
  expect(nextLink.sessionId).not.toBe(firstLink.sessionId);
  expect(replacement.runtimeGeneration).toBe(first.runtimeGeneration + 1);
  expect(await qr.getAttribute("src")).toBe(nextLink.qrCodeDataUrl);
  await showWholeQr();
  await capture("03-new-qr-session.png");
  console.log("PASS: Get new code replaces the session, image, and runtime generation.");
  await page.getByRole("button", { name: "Cancel linking", exact: true }).click();
  await qr.waitFor({ state: "detached" });
  expect((await account()).credentials).not.toHaveProperty("deviceLink");
  expect(manager.status(first.id).state).toBe("stopped");
  expect(requests.some(request => request.path.endsWith("/restart") && request.status === 200)).toBe(true);
  expect(requests.some(request => request.path.endsWith("/configuration"))).toBe(false);
  expect(pageErrors).toEqual([]);
  console.log("PASS: Cancel removes the QR and stops the runtime; no phone was approved.");
  await writeFile(join(output, "results.json"), JSON.stringify({ head: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(), provider: "Real WhatsApp network via exact bundled wacli 0.26.0 in Linux ARM64", phoneApproved: false, messagesSent: false, assertions: ["Zero setup parameter inputs", "Connect displays valid PNG returned by native WhatsApp QR event", "Initial QR lifetime exceeds 20 seconds", "Get new code changes session, image and runtime generation", "Cancel clears credentials and stops runtime", "No configuration requests", "No browser errors"], requests, runtimeCalls, screenshots: ["01-no-parameters.png", "02-real-whatsapp-qr.png", "03-new-qr-session.png"] }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await service.close();
  await manager.closeAll();
  for (const name of containers) Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
  api.stop(true);
  if (installationId) await db.pluginInstallation.deleteMany({ where: { id: installationId } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
}
