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
  "a working local connector survives a computer restart and starts on its next call",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const directory = await mkdtemp(join(tmpdir(), "plugin-restart-"));
    let manager = new StdioMcpManager(directory, 10_000);
    let launches = 0;
    const computerFetch: NonNullable<ConstructorParameters<typeof PluginService>[1]> = async (path, init) => {
      const id = path.split("/")[4]!;
      if (init?.method === "GET") return Response.json(manager.status(id));
      if (init?.method === "DELETE") {
        await manager.close(id);
        return Response.json({});
      }
      launches++;
      const body = JSON.parse(String(init?.body));
      if (path.endsWith("/call"))
        return Response.json({
          result: await manager.call(id, body.configuration, body.toolName, body.arguments, body.runtimeGeneration),
        });
      return Response.json({ tools: await manager.discover(id, body.configuration, body.runtimeGeneration) });
    };
    const service = new PluginService(db, computerFetch);
    const health = () => (service as unknown as { refreshLocalConnections(): Promise<void> }).refreshLocalConnections();
    const starts = async () =>
      (await readFile(join(directory, "starts"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
    const restartComputer = async () => {
      await manager.closeAll();
      manager = new StdioMcpManager(directory, 10_000);
    };
    let installationId = "";
    try {
      await writeFile(join(directory, "approved"), "yes");
      const added = await Effect.runPromise(
        service.addCustomMcp({
          name: "Restart fixture",
          command: "node",
          args: [join(import.meta.dir, "../../../computer/test/fixtures/gated-mcp.mjs"), directory],
        })
      );
      const id = added.connectionId;
      installationId = (await db.pluginConnection.findUniqueOrThrow({ where: { id } })).installationId;
      const row = () => db.pluginConnection.findUniqueOrThrow({ where: { id } });
      const call = () => Effect.runPromise(service.testTool(id, { toolName: "pid", arguments: {}, confirmSideEffect: true }));

      expect(await Effect.runPromise(service.connect(id))).toMatchObject({ status: "ready", toolCount: 1 });
      expect(await starts()).toBe(1);

      await restartComputer();
      expect(manager.status(id).state).toBe("stopped");
      const launchesBefore = launches;
      for (let i = 0; i < 3; i++) await health();
      expect((await row()).status).toBe("ready");
      expect(launches).toBe(launchesBefore);
      expect(await starts()).toBe(1);

      await call();
      expect(await starts()).toBe(2);
      expect(manager.status(id).state).toBe("ready");

      // Rows that an older health check marked broken after a restart recover.
      await restartComputer();
      await db.pluginConnection.update({
        where: { id },
        data: {
          status: "error",
          statusMessage: "Local runtime unavailable: MCP process is not connected. Reconnect to try again.",
        },
      });
      await health();
      expect((await row()).status).toBe("ready");
      expect(await starts()).toBe(2);
      await call();
      expect(await starts()).toBe(3);

      // A process that exits on its own keeps the computer's reason and is not retried.
      await Effect.runPromise(service.testTool(id, { toolName: "pid", arguments: { exit: true }, confirmSideEffect: true }));
      const deadline = Date.now() + 5_000;
      while (manager.status(id).state !== "error") {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(10);
      }
      for (let i = 0; i < 3; i++) await health();
      expect(await row()).toMatchObject({
        status: "error",
        statusMessage: "Local runtime unavailable: MCP process exited. Reconnect to try again.",
      });
      expect(await starts()).toBe(3);
    } finally {
      await service.close();
      await manager.closeAll();
      if (installationId) await db.pluginInstallation.delete({ where: { id: installationId } });
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000
);
