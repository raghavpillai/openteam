import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../../computer/src/mcp-manager";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!databaseUrl);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function harness(run: (context: {
  db: ReturnType<typeof createPrismaClient>;
  service: PluginService;
  peerService: PluginService;
  manager: StdioMcpManager;
  directory: string;
  id: string;
  starts(): Promise<number>;
  waitFor(check: () => boolean | Promise<boolean>): Promise<void>;
  holdPost: ReturnType<typeof gate>;
  postStarted: ReturnType<typeof gate>;
  delayPost(): void;
}) => Promise<void>) {
  const db = createPrismaClient(databaseUrl!);
  const directory = await mkdtemp(join(tmpdir(), "plugin-stress-"));
  const manager = new StdioMcpManager(directory, 10_000);
  const holdPost = gate();
  const postStarted = gate();
  let delayed = false;
  let installationId = "";
  const computerFetch: NonNullable<ConstructorParameters<typeof PluginService>[1]> = async (path, init) => {
    const id = path.split("/")[4]!;
    if (init?.method === "GET") return Response.json(manager.status(id));
    if (init?.method === "DELETE") {
      const header = new Headers(init.headers).get("x-openteam-mcp-generation");
      await manager.close(id, header === null ? undefined : Number(header));
      return Response.json({});
    }
    if (delayed) {
      delayed = false;
      postStarted.release();
      await holdPost.promise;
    }
    const { configuration, runtimeGeneration } = JSON.parse(String(init?.body));
    return Response.json({ tools: await manager.discover(id, configuration, runtimeGeneration) });
  };
  const service = new PluginService(db, computerFetch);
  const peerService = new PluginService(db, computerFetch);
  const starts = async () => (await readFile(join(directory, "starts"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
  async function waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      expect(Date.now()).toBeLessThan(deadline);
      await Bun.sleep(10);
    }
  }
  try {
    const added = await Effect.runPromise(service.addCustomMcp({
      name: "MCP stress fixture",
      command: "node",
      args: [join(import.meta.dir, "../../../computer/test/fixtures/gated-mcp.mjs"), directory],
    }));
    installationId = (await db.pluginConnection.findUniqueOrThrow({ where: { id: added.connectionId } })).installationId;
    await run({ db, service, peerService, manager, directory, id: added.connectionId, starts, waitFor, holdPost, postStarted, delayPost: () => { delayed = true; } });
  } finally {
    holdPost.release();
    await service.close();
    await peerService.close();
    await manager.closeAll();
    if (installationId) await db.pluginInstallation.delete({ where: { id: installationId } });
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

integration("disconnect wins over a discovery request delayed before reaching the computer", async () => {
  await harness(async ({ db, service, manager, directory, id, delayPost, postStarted, holdPost }) => {
    await writeFile(join(directory, "approved"), "yes");
    delayPost();
    const connecting = Effect.runPromise(service.connect(id)).then(() => "ready", () => "cancelled");
    await postStarted.promise;
    await Effect.runPromise(service.disconnect(id));
    holdPost.release();
    expect(await connecting).toBe("cancelled");
    expect((await db.pluginConnection.findUniqueOrThrow({ where: { id } })).status).toBe("disconnected");
    expect(manager.status(id).state).toBe("stopped");
  });
}, 20_000);

integration("30 overlapping restarts during browser consent share one replacement", async () => {
  await harness(async ({ service, manager, directory, id, starts, waitFor }) => {
    const initial = Effect.runPromise(service.connect(id)).then(() => "ready", () => "cancelled");
    await waitFor(async () => (await starts()) === 1);
    const restarts = Promise.allSettled(Array.from({ length: 30 }, () => Effect.runPromise(service.restart(id))));
    await waitFor(async () => (await starts()) >= 2);
    await writeFile(join(directory, "approved"), "yes");
    expect(await initial).toBe("cancelled");
    expect((await restarts).every(result => result.status === "fulfilled")).toBe(true);
    expect(await starts()).toBe(2);
    expect(manager.status(id).state).toBe("ready");
  });
}, 25_000);

for (const action of ["disconnect", "restart"] as const) {
  integration(`${action} permits a fresh login without waiting for a delayed old RPC`, async () => {
    await harness(async ({ db, service, manager, directory, id, starts, waitFor, delayPost, postStarted, holdPost }) => {
      await writeFile(join(directory, "approved"), "yes");
      delayPost();
      const original = Effect.runPromise(service.connect(id)).then(() => "ready", () => "cancelled");
      await postStarted.promise;
      if (action === "disconnect") await Effect.runPromise(service.disconnect(id));
      const fresh = action === "restart"
        ? Effect.runPromise(service.restart(id))
        : Effect.runPromise(service.connect(id));
      await waitFor(() => manager.status(id).state === "ready");
      expect(await fresh).toMatchObject({ status: "ready" });
      const pid = (await readFile(join(directory, "starts"), "utf8")).trim();
      holdPost.release();
      expect(await original).toBe("cancelled");
      expect(await starts()).toBe(1);
      expect(manager.status(id).state).toBe("ready");
      expect((await db.pluginConnection.findUniqueOrThrow({ where: { id } })).status).toBe("ready");
      expect((await readFile(join(directory, "starts"), "utf8")).trim()).toBe(pid);
    });
  }, 20_000);
}

integration("200 connect requests plus 500 health ticks preserve one waiting login", async () => {
  await harness(async ({ db, service, manager, directory, id, starts, waitFor }) => {
    const pending = Promise.all(Array.from({ length: 200 }, () => Effect.runPromise(service.connect(id))));
    await waitFor(async () => (await starts()) === 1);
    const health = service as unknown as { refreshLocalConnections(): Promise<void> };
    for (let i = 0; i < 500; i++) await health.refreshLocalConnections();
    expect(await starts()).toBe(1);
    expect((await db.pluginConnection.findUniqueOrThrow({ where: { id } })).status).toBe("needs_auth");
    await writeFile(join(directory, "approved"), "yes");
    expect((await pending).every(result => "status" in result && result.status === "ready")).toBe(true);
    expect(manager.status(id).state).toBe("ready");
    expect(await starts()).toBe(1);
  });
}, 25_000);

integration("two independent server instances share one computer login", async () => {
  await harness(async ({ service, peerService, directory, id, starts, waitFor }) => {
    const pending = Promise.all(Array.from({ length: 200 }, (_, i) =>
      Effect.runPromise((i % 2 ? service : peerService).connect(id))));
    await waitFor(async () => (await starts()) === 1);
    await writeFile(join(directory, "approved"), "yes");
    expect((await pending).every(result => "status" in result && result.status === "ready")).toBe(true);
    expect(await starts()).toBe(1);
  });
}, 20_000);
