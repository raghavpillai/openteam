import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { ConnectorFileTransfers } from "../../src/services/plugin/file-transfers";
import { createHash } from "node:crypto";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "file transfers pin account, hash, policy and call identity and do not replay writes after restart",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const botId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    let writes = 0;
    let providerFailure: Error | undefined;
    try {
      await db.bot.create({
        data: {
          id: botId,
          name: "File fixture",
          defaultDirectory: "/workspace",
          status: "active",
          conversation: { create: {} },
        },
      });
      await db.pluginInstallation.create({
        data: {
          id: installationId,
          pluginKey: "google-drive",
          name: "File fixture",
          version: "fixture",
          publisher: "OpenTeam",
          description: "Fixture",
          manifest: {},
          status: "installed",
          mode: "enabled",
          enablements: { create: { botId, enabled: true } },
        },
      });
      const connection = await db.pluginConnection.create({
        data: {
          installationId,
          connectorKey: "drive",
          name: "Fixture Drive",
          transport: "stdio",
          authType: "oauth",
          status: "ready",
          configuration: {},
          credentials: {},
          grants: { create: { botId, enabled: true } },
        },
      });
      const service = () =>
        new ConnectorFileTransfers(
          db,
          async () => "fixture-token",
          () =>
            ({
              upload: async () => {
                writes++;
                if (providerFailure) throw providerFailure;
                return { id: "uploaded", name: "file.bin", sizeBytes: 3 };
              },
            }) as never
        );
      const context = { botId, runId, callId };
      const bytes = Buffer.from("abc");
      const raw = {
        tool: "upload_file",
        input: { connection: connection.id, sourcePath: "/workspace/file.bin", destination: {} },
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: 3,
      };
      expect(await service().prepare(context, raw)).toMatchObject({
        connectionId: connection.id,
        decision: "prompt",
      });
      await expect(
        service().execute(context, { ...raw, bytesBase64: bytes.toString("base64") })
      ).rejects.toThrow("approval");
      expect(writes).toBe(0);
      await expect(
        service().execute(context, {
          ...raw,
          reviewed: true,
          bytesBase64: Buffer.from("abd").toString("base64"),
        })
      ).rejects.toThrow("changed");
      expect(writes).toBe(0);
      expect(
        await service().execute(context, {
          ...raw,
          reviewed: true,
          bytesBase64: bytes.toString("base64"),
        })
      ).toMatchObject({ id: "uploaded" });
      expect(writes).toBe(1);
      expect(
        await service().execute(context, {
          ...raw,
          reviewed: true,
          bytesBase64: bytes.toString("base64"),
        })
      ).toMatchObject({ id: "uploaded" });
      expect(writes).toBe(1);
      const stored = await db.connectorFileTransfer.findUniqueOrThrow({ where: { callId } });
      expect(JSON.stringify(stored)).not.toContain("bytesBase64");
      expect(JSON.stringify(stored)).not.toContain("fixture-token");
      for (const [status,kind] of [[401,"needs_auth"],[404,"invalid_destination"],[403,"rejected"],[503,"uncertain"]] as const) {
        const failedContext={...context,callId:crypto.randomUUID()};
        await service().prepare(failedContext,raw);
        providerFailure=Object.assign(new Error("Private provider diagnostic"),{status});
        const result=await service().execute(failedContext,{...raw,reviewed:true,bytesBase64:bytes.toString("base64")});
        expect(result).toMatchObject({outcome:{kind}});
        expect(JSON.stringify(result)).not.toContain("Private provider diagnostic");
        const before=writes;
        await expect(service().execute(failedContext,{...raw,reviewed:true,bytesBase64:bytes.toString("base64")})).rejects.toThrow("uncertain");
        expect(writes).toBe(before);
      }
      await db.botPluginConnectionGrant.updateMany({
        where: { connectionId: connection.id, botId },
        data: { enabled: false },
      });
      expect(await service().prepare({ ...context, callId: crypto.randomUUID() }, raw))
        .toMatchObject({outcome:{kind:"unknown_connection",available:[]}});
      expect(writes).toBe(5);
    } finally {
      await db.connectorFileTransfer.deleteMany({ where: { botId } });
      await db.pluginInstallation.deleteMany({ where: { id: installationId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);
