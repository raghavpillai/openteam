/** Live regression for the installed mcp-remote bridge. Run inside the local
 * computer with a disposable OPENTEAM_TEST_DATABASE_URL. Leaves existing
 * connector accounts, cached credentials, and browser tabs intact. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createPrismaClient } from "../../../packages/db/src";
import { Effect } from "effect";
import { PluginService } from "../../server/src/services/plugin-service";
import { StdioMcpManager } from "../src/mcp-manager";
import { CdpConnection } from "../src/browser/cdp-connection";

assert(process.env.OPENTEAM_TEST_DATABASE_URL, "Use a disposable test database");
const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
const directory = await mkdtemp("/workspace/.ramp-login-qa-");
const manager = new StdioMcpManager(join(directory, "packages"));
const cdpEndpoint = process.env.OPENTEAM_TEST_CDP_URL ?? "http://127.0.0.1:9300";
const tabs = async (): Promise<Array<{ id: string; type: string; url: string }>> => {
  const response = await fetch(`${cdpEndpoint}/json/list`);
  assert(response.ok, "The bot browser must be running");
  return response.json();
};
const initialTabs = await tabs();
const initialIds = new Set(initialTabs.map((tab) => tab.id));
const starts = new Map<string, number>();
const stderr = console.error;
console.error = (...args: unknown[]) => {
  const message = args.map(String).join(" ");
  const id = message.match(/\[stdio-mcp:([^\]]+)\]/)?.[1];
  if (id && message.includes("Using specified callback port:"))
    starts.set(id, (starts.get(id) ?? 0) + 1);
  // Provider URLs include authorization state; keep only aggregate evidence.
};
const installations: string[] = [];
const methods: string[] = [];
const service = new PluginService(db, async (path, init) => {
  const id = path.split("/")[4]!;
  methods.push(`${init?.method} ${path}`);
  if (init?.method === "GET") return Response.json(manager.status(id));
  if (init?.method === "DELETE") {
    await manager.close(id);
    return Response.json({});
  }
  const { configuration } = JSON.parse(String(init?.body));
  return Response.json({ tools: await manager.discover(id, configuration) });
});
const health = service as unknown as { refreshLocalConnections(): Promise<void> };
const bridge = "/workspace/ramp-mcp-bridge/node_modules/mcp-remote/dist/proxy.js";
const command = "/usr/bin/node";
const args = (port: number) => [
  bridge,
  "https://mcp.ramp.com/mcp",
  String(port),
  "--host",
  "127.0.0.1",
  "--transport",
  "http-only",
  "--auth-timeout",
  "300",
];
const addedConsentTabs = async () =>
  (await tabs()).filter((tab) => {
    if (initialIds.has(tab.id) || tab.type !== "page") return false;
    try {
      const url = new URL(tab.url);
      return (
        url.hostname === "app.ramp.com" &&
        url.pathname === "/v1/authorize" &&
        url.searchParams.get("redirect_uri")?.includes(":9697/")
      );
    } catch {
      return false;
    }
  });
try {
  const pending = await Effect.runPromise(
    service.addCustomMcp({
      name: "Ramp pending login QA",
      command,
      args: args(9697),
      env: { MCP_REMOTE_CONFIG_DIR: join(directory, "isolated-auth") },
    })
  );
  installations.push(pending.installationId);
  const connects = Array.from({ length: 12 }, () =>
    Effect.runPromise(service.connect(pending.connectionId))
  );
  const settled = Promise.allSettled(connects);
  for (let i = 0; i < 9; i++) {
    await Bun.sleep(5000);
    await health.refreshLocalConnections();
    assert.equal(manager.status(pending.connectionId).state, "starting");
    assert.equal(starts.get(pending.connectionId), 1, "one bridge process for all requests");
  }
  const consentTabs = await addedConsentTabs();
  assert.equal(
    consentTabs.length,
    1,
    "only one consent page after 45 seconds and repeated health probes"
  );
  const row = await db.pluginConnection.findUniqueOrThrow({ where: { id: pending.connectionId } });
  assert.equal(row.status, "needs_auth");
  assert(row.statusMessage?.startsWith("Local runtime starting:"));
  await Effect.runPromise(service.disconnect(pending.connectionId));
  assert((await settled).every((result) => result.status === "rejected"));
  assert.equal(manager.status(pending.connectionId).state, "stopped");
  console.log(
    JSON.stringify({
      scenario: "real Ramp pending consent",
      concurrentRequests: 12,
      observationSeconds: 45,
      bridgeStarts: starts.get(pending.connectionId),
      newConsentTabs: consentTabs.length,
      cancellation: "stopped",
    })
  );

  const cached = await Effect.runPromise(
    service.addCustomMcp({ name: "Ramp cached login QA", command, args: args(9696) })
  );
  installations.push(cached.installationId);
  const ready = await Effect.runPromise(service.connect(cached.connectionId));
  assert(
    "toolCount" in ready && ready.toolCount > 0,
    "existing Ramp authorization must still discover tools"
  );
  for (let i = 0; i < 5; i++) await health.refreshLocalConnections();
  assert.equal(starts.get(cached.connectionId), 1);
  assert.equal(
    (await addedConsentTabs()).length,
    1,
    "cached credentials must not open another consent page"
  );
  console.log(
    JSON.stringify({
      scenario: "real Ramp cached authorization",
      bridgeStarts: starts.get(cached.connectionId),
      toolCount: ready.toolCount,
      additionalConsentTabs: 0,
    })
  );
} finally {
  await service.close();
  await manager.closeAll();
  for (const installationId of installations)
    await db.pluginInstallation.delete({ where: { id: installationId } });
  await db.$disconnect();
  // Close only the uniquely identified test consent page, never an existing tab.
  const added = await addedConsentTabs();
  if (added.length) {
    const version = (await (await fetch(`${cdpEndpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
    try {
      for (const tab of added) await cdp.call("Target.closeTarget", { targetId: tab.id });
    } finally {
      cdp.close();
    }
  }
  console.error = stderr;
  await rm(directory, { recursive: true, force: true });
}
