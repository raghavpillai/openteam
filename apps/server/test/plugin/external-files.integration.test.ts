import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { PluginConnectors } from "../../src/services/plugin/connectors";
import { Effect } from "effect";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "native delivery respects legacy send review, binds reviewed bytes, and cannot replay sends",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const botId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    const original = globalThis.fetch;
    let writes = 0;
    try {
      const bot = await db.bot.create({
        data: {
          id: botId,
          name: "Native delivery fixture",
          defaultDirectory: "/tmp",
          status: "active",
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
      await db.run.create({
        data: {
          id: runId,
          botId,
          conversationId: bot.conversation!.id,
          userMessageId: crypto.randomUUID(),
          status: "running",
        },
      });
      await db.pluginInstallation.create({
        data: {
          id: installationId,
          pluginKey: "slack",
          name: "Fixture Slack",
          version: "fixture",
          publisher: "Fixture",
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
          connectorKey: "slack",
          name: "Slack fixture",
          transport: "http",
          authType: "token",
          status: "ready",
          configuration: {},
          credentials: {},
          grants: { create: { botId, enabled: true } },
          policies: { create: { botId, toolName: "slack_send_message", decision: "prompt" } },
        },
      });
      const service = new PluginConnectors(
        db,
        {} as never,
        () => Effect.succeed({}),
        async () => ({}),
        undefined,
        async () => "fixture-token"
      );
      globalThis.fetch = (async (input) => {
        writes++;
        const url = String(input);
        if (url.endsWith("files.getUploadURLExternal"))
          return Response.json({
            ok: true,
            upload_url: "https://files.slack.com/fixture-upload",
            file_id: "F1",
          });
        if (url.includes("fixture-upload")) return new Response("ok");
        return Response.json({ ok: true, files: [{ id: "F1" }] });
      }) as typeof fetch;
      const request = {
        botId,
        runId,
        callId,
        address: connection.id + ":C1",
        content: "Fixture attachment",
        files: [
          {
            assetId: "fixture",
            name: "file.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("abc"),
          },
        ],
      };
      await expect(service.deliverConnectedChannel(request)).rejects.toThrow("requires review");
      expect(writes).toBe(0);
      await expect(
        service.deliverConnectedChannel({
          ...request,
          reviewedExternal: true,
          files: [{ ...request.files[0]!, bytes: Buffer.from("abd") }],
        })
      ).rejects.toThrow("changed");
      expect(writes).toBe(0);
      await service.deliverConnectedChannel({ ...request, reviewedExternal: true });
      expect(writes).toBe(3);
      await service.deliverConnectedChannel({ ...request, reviewedExternal: true });
      expect(writes).toBe(3);
      await db.pluginToolPolicy.updateMany({
        where: { connectionId: connection.id },
        data: { decision: "deny" },
      });
      await expect(
        service.deliverConnectedChannel({
          ...request,
          callId: crypto.randomUUID(),
          reviewedExternal: true,
        })
      ).rejects.toThrow("policy");
      expect(writes).toBe(3);
    } finally {
      globalThis.fetch = original;
      await db.pluginInstallation.deleteMany({ where: { id: installationId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);
