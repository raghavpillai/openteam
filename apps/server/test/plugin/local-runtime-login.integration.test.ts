import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../../computer/src/mcp-manager";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "real database and child process preserve one pending login through caller timeout, health probes and retries",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const directory = await mkdtemp(join(tmpdir(), "plugin-login-"));
    const manager = new StdioMcpManager(directory, 1500);
    let installationId = "";
    let requestTimeout = false;
    const methods: string[] = [];
    const service = new PluginService(db, async (path, init) => {
      methods.push(`${init?.method} ${path}`);
      const id = path.split("/")[4]!;
      if (init?.method === "GET") return Response.json(manager.status(id));
      if (init?.method === "DELETE") {
        await manager.close(id);
        return Response.json({});
      }
      const { configuration } = JSON.parse(String(init?.body));
      const pending = manager.discover(id, configuration);
      if (requestTimeout) {
        // An RPC client can disappear while the computer keeps its startup attempt.
        void pending.catch(() => {});
        await Bun.sleep(100);
        throw new Error("Caller timed out");
      }
      return Response.json({ tools: await pending });
    });
    const health = service as unknown as { refreshLocalConnections(): Promise<void> };
    const starts = async () =>
      (await readFile(join(directory, "starts"), "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean).length;
    async function waitFor(check: () => Promise<boolean>) {
      const deadline = Date.now() + 4000;
      while (!(await check())) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(10);
      }
    }
    try {
      requestTimeout = true;
      const added = await Effect.runPromise(
        service.addCustomMcp({
          name: "Gated Ramp regression",
          command: "node",
          args: [join(import.meta.dir, "../../../computer/test/fixtures/gated-mcp.mjs"), directory],
        })
      );
      const connection = await db.pluginConnection.findUniqueOrThrow({
        where: { id: added.connectionId },
      });
      installationId = connection.installationId;
      await expect(Effect.runPromise(service.connect(added.connectionId))).rejects.toThrow(
        "Caller timed out"
      );
      await waitFor(async () => (await starts()) === 1);
      requestTimeout = false;
      const connects = Array.from({ length: 6 }, () =>
        Effect.runPromise(service.connect(added.connectionId))
      );
      for (let i = 0; i < 5; i++) await health.refreshLocalConnections();
      expect(await starts()).toBe(1);
      expect(
        (await db.pluginConnection.findUniqueOrThrow({ where: { id: added.connectionId } })).status
      ).toBe("needs_auth");
      await writeFile(join(directory, "approved"), "yes");
      expect(
        (await Promise.all(connects)).every(
          (result) => "status" in result && result.status === "ready"
        )
      ).toBe(true);
      expect(await starts()).toBe(1);
      expect(
        (await db.pluginConnection.findUniqueOrThrow({ where: { id: added.connectionId } })).status
      ).toBe("ready");

      await manager.close(added.connectionId);
      await rm(join(directory, "approved"));
      await expect(Effect.runPromise(service.connect(added.connectionId))).rejects.toThrow();
      const before = await starts();
      for (let i = 0; i < 5; i++) await health.refreshLocalConnections();
      expect(await starts()).toBe(before);
      await writeFile(join(directory, "approved"), "yes");
      const retries = await Promise.all(
        Array.from({ length: 6 }, () => Effect.runPromise(service.connect(added.connectionId)))
      );
      expect(retries.every((result) => "status" in result && result.status === "ready")).toBe(true);
      expect(await starts()).toBe(before + 1);
      expect(methods.filter((method) => method.endsWith("/discover"))).toHaveLength(4);
    } finally {
      await service.close();
      await manager.closeAll();
      if (installationId) await db.pluginInstallation.delete({ where: { id: installationId } });
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000
);
