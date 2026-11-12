import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { ConnectorFileTransfers } from "../../src/services/plugin/file-transfers";
import { describeUploadFileOutcome } from "@openteam/contracts/reference-formatters";
import { createHash } from "node:crypto";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl).each(["google-drive", "gmail"] as const)(
  "%s file transfers pin account, hash and call identity and do not replay writes after restart",
  async (pluginKey) => {
    const db = createPrismaClient(databaseUrl!);
    const botId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    let writes = 0;
    let providerFailure: Error | undefined;
    let preparationFailure: Error | undefined;
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
          pluginKey,
          name: `${pluginKey} fixture`,
          version: "fixture",
          publisher: "OpenTeam",
          description: "Fixture",
          manifest: {},
          status: "installed",
        },
      });
      const connection = await db.pluginConnection.create({
        data: {
          installationId,
          connectorKey: pluginKey === "gmail" ? "gmail" : "drive",
          name: `${pluginKey} fixture`,
          transport: "stdio",
          authType: "oauth",
          status: "ready",
          configuration: {},
          credentials: {},
        },
      });
      const service = () =>
        new ConnectorFileTransfers(
          db,
          async () => {
            if (preparationFailure) throw preparationFailure;
            return "fixture-token";
          },
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
        tool: "UploadFile",
        input: { connection: connection.id, sourcePath: "/workspace/file.bin", destination: pluginKey === "gmail" ? { draftId: "fixture-draft" } : {} },
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: 3,
      };
      expect(await service().prepare(context, raw)).toMatchObject({
        connectionId: connection.id,
      });
      await expect(
        service().execute(context, {
          ...raw,
          bytesBase64: Buffer.from("abd").toString("base64"),
        })
      ).rejects.toThrow("changed");
      expect(writes).toBe(0);
      expect(
        await service().execute(context, {
          ...raw,
          bytesBase64: bytes.toString("base64"),
        })
      ).toMatchObject({ id: "uploaded" });
      expect(writes).toBe(1);
      expect(
        await service().execute(context, {
          ...raw,
          bytesBase64: bytes.toString("base64"),
        })
      ).toMatchObject({ id: "uploaded" });
      expect(writes).toBe(1);
      const stored = await db.connectorFileTransfer.findUniqueOrThrow({ where: { callId } });
      expect(JSON.stringify(stored)).not.toContain("bytesBase64");
      expect(JSON.stringify(stored)).not.toContain("fixture-token");
      const preparationContext = { ...context, callId: crypto.randomUUID() };
      await service().prepare(preparationContext, raw);
      preparationFailure = new Error("Private preparation diagnostic");
      const preparationResult = await service().execute(preparationContext, {
        ...raw,
        bytesBase64: bytes.toString("base64"),
      });
      expect(preparationResult).toMatchObject({ outcome: {
        kind: "unavailable",
        message: "OpenTeam could not prepare the upload before contacting the provider.",
      } });
      expect(describeUploadFileOutcome((preparationResult as any).outcome, raw.input)).toContain("Nothing was uploaded");
      expect(JSON.stringify(preparationResult)).not.toContain("Private preparation diagnostic");
      expect(writes).toBe(1);
      await expect(service().execute(preparationContext, {
        ...raw,
        bytesBase64: bytes.toString("base64"),
      })).rejects.toThrow("uncertain");
      preparationFailure = undefined;
      for (const [status,kind] of [[401,"needs_auth"],[404,"invalid_destination"],[403,"rejected"],[503,"uncertain"]] as const) {
        const failedContext={...context,callId:crypto.randomUUID()};
        await service().prepare(failedContext,raw);
        providerFailure=Object.assign(new Error("Private provider diagnostic"),{status});
        const result=await service().execute(failedContext,{...raw,bytesBase64:bytes.toString("base64")});
        expect(result).toMatchObject({outcome:{kind}});
        expect(JSON.stringify(result)).not.toContain("Private provider diagnostic");
        const before=writes;
        await expect(service().execute(failedContext,{...raw,bytesBase64:bytes.toString("base64")})).rejects.toThrow("uncertain");
        expect(writes).toBe(before);
      }
      // Two accounts of one service: the short name names both instead of calling the service unknown.
      const second = await db.pluginConnection.create({ data: {
        installationId, connectorKey: pluginKey === "gmail" ? "gmail" : "drive", name: `${pluginKey} fixture`, alias: "home", transport: "stdio", authType: "oauth", status: "ready", configuration: {}, credentials: {},
      } });
      const ambiguous = await service().prepare({ ...context, callId: crypto.randomUUID() }, { ...raw, input: { ...raw.input, connection: pluginKey } });
      expect(ambiguous).toMatchObject({ outcome: { kind: "ambiguous_connection", service: `${pluginKey} fixture` } });
      expect(describeUploadFileOutcome((ambiguous as any).outcome, { connection: pluginKey, sourcePath: "/workspace/file.bin" })).toBe(
        `${JSON.stringify(pluginKey)} matches several connected ${pluginKey} fixture accounts: ${(ambiguous as any).outcome.candidates.join(", ")}. Pass one of those identifiers as connection (GetMcpServerStatus shows which account each one is) so the right account is used. Nothing was uploaded.`
      );
      expect((ambiguous as any).outcome.candidates).toHaveLength(2);
      await db.pluginConnection.delete({where:{id:second.id}});
      await db.pluginConnection.delete({where:{id:connection.id}});
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
