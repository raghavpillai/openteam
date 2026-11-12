import { createUtilityPluginFixture } from "./fixtures/utility-plugin";
import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { importPackageArchive } from "@openteam/plugin-sdk/archive";
import { PluginService } from "../../src/services/plugin-service";
import { pluginRuntimeContext } from "../../../worker/src/plugins";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!databaseUrl);

integration(
  "management preserves accounts, direct tool execution and snapshots through configuration, discovery and upgrades",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    let syncFails = true;
    const service = new PluginService(prisma, undefined, {
      syncPluginSkillCache: async () => {
        if (syncFails) throw new Error("Fixture volume unavailable");
      },
      writeConnectorSecret: async () => {},
    });
    const botId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const key = `test-package-${crypto.randomUUID()}`;
    const base = createUtilityPluginFixture();
    const definition = {
      ...base,
      key,
      name: "Parity test",
      components: ["mcp", "skills"] as Array<"mcp" | "skills">,
      connections: [
        base.connections[0]!,
        { ...base.connections[0]!, key: "second", name: "Second connector" },
      ],
      skills: [
        {
          name: "fixture-skill",
          description: "Test skill",
          body: "Use references/check.md",
          path: "skills/fixture",
        },
      ],
      files: { "skills/fixture/references/check.md": "Preserved supporting file" },
    };
    let draftId = "";
    try {
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Plugin management test",
          defaultDirectory: "/workspace/test",
          status: "active",
          onboardingStatus: "completed",
          conversation: { create: { id: conversationId } },
        },
      });
      await prisma.run.create({
        data: {
          id: runId,
          botId,
          conversationId,
          userMessageId: crypto.randomUUID(),
          status: "running",
        },
      });
      const draft = await Effect.runPromise(
        service.management.importFiles({ "plugin.json": JSON.stringify(definition) })
      );
      draftId = draft.id;
      await Effect.runPromise(service.management.installDraft(draft.id));
      expect((await Effect.runPromise(service.management.package(key))).skillSyncStatus).toBe(
        "error"
      );
      syncFails = false;
      await Effect.runPromise(service.management.retrySync());
      expect((await Effect.runPromise(service.management.package(key))).skillSyncStatus).toBe(
        "ready"
      );
      const install = await prisma.pluginInstallation.findUniqueOrThrow({
        where: { pluginKey: key },
        include: { connections: true },
      });
      const first = install.connections.find((entry) => entry.connectorKey === "utility")!;
      for (const connection of install.connections) {
        await Effect.runPromise(service.connect(connection.id));
      }
      const initialNamespaces = await service.dynamicNamespaces(botId);
      expect(new Set(initialNamespaces.map((entry) => entry.name)).size).toBe(2);
      await Effect.runPromise(service.renameAccount(first.id, "renamed"));
      const renamedNamespaces = await service.dynamicNamespaces(botId);
      expect(renamedNamespaces.map(entry=>entry.name)).not.toEqual(initialNamespaces.map(entry=>entry.name));
      expect(renamedNamespaces.find(entry=>entry.tools.some(tool=>tool.connectionId===first.id))?.name).toEndWith("--renamed");
      await Effect.runPromise(service.connect(first.id));
      expect(
        (await service.dynamicNamespaces(botId)).flatMap((entry) => entry.tools).some(
          (tool) => tool.connectionId === first.id && tool.name === "echo"
        )
      ).toBe(true);
      const projected = await pluginRuntimeContext(prisma, botId);
      expect(
        projected.dynamicNamespaces
          .flatMap((entry) => entry.tools)
          .some((tool) => tool.connectionId === first.id && tool.name === "echo")
      ).toBe(true);
      expect(
        await service.invoke({
          connectionId: first.id,
          botId,
          runId,
          callId: crypto.randomUUID(),
          toolName: "echo",
          arguments: { text: "direct read" },
        })
      ).toEqual({ text: "direct read" });
      const write = {
        connectionId: first.id,
        botId,
        runId,
        callId: crypto.randomUUID(),
        toolName: "remember_note",
        arguments: { note: "Direct write executes once" },
      };
      expect(await service.invoke(write)).toEqual({ remembered: true });
      expect(await service.invoke(write)).toEqual({ remembered: true });
      expect(
        await prisma.pluginActivity.count({
          where: { connectionId: first.id, kind: "fixture.note" },
        })
      ).toBe(1);
      await Effect.runPromise(service.disconnect(first.id));
      await expect(service.invoke({ ...write, callId: crypto.randomUUID() }))
        .rejects.toMatchObject({ code: "plugin_connection_not_ready" });
      expect(await prisma.pluginActivity.count({
        where: { connectionId: first.id, kind: "fixture.note" },
      })).toBe(1);
      await Effect.runPromise(service.connect(first.id));
      await Effect.runPromise(
        service.management.saveDraft(draft.id, {
          ...definition,
          version: "1.1.0",
          skills: [{ ...definition.skills[0], body: "Updated instructions" }],
        })
      );
      const review = await Effect.runPromise(service.management.package(key));
      expect(review.update?.changes).toContain("Change skill: fixture-skill");
      await expect(Effect.runPromise(service.management.update(key, "stale"))).rejects.toThrow(
        "review"
      );
      await Effect.runPromise(service.management.update(key, review.update!.digest));
      const updated = await prisma.pluginConnection.findUniqueOrThrow({
        where: { id: first.id },
        include: { },
      });
      expect(updated.alias).toBe("renamed");
      expect((await Effect.runPromise(service.management.package(key))).definition.version).toBe(
        "1.1.0"
      );
      await Effect.runPromise(service.management.update(key, "", true));
      expect((await Effect.runPromise(service.management.package(key))).definition.version).toBe(
        base.version
      );
      // Applying a package invalidates discovery. Reconnect before using its new snapshot.
      expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: first.id } })).status)
        .toBe("disconnected");
      await Effect.runPromise(service.connect(first.id));
      const directNamespaces=await service.dynamicNamespaces(botId);
      expect(directNamespaces.length).toBeGreaterThan(0);
      expect(await service.dynamicNamespaces(botId)).toEqual(directNamespaces);
      const exported = importPackageArchive(
        await Effect.runPromise(service.management.exportInstalled(key))
      );
      expect(exported.definition.files?.["skills/fixture/references/check.md"]).toBe(
        "Preserved supporting file"
      );
    } finally {
      await service.close();
      await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } });
      if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.$disconnect();
    }
  }
);

integration(
  "saved secrets never leave configuration or export and new accounts do not copy account credentials",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const service = new PluginService(prisma);
    let key = "";
    try {
      const added = await Effect.runPromise(
        service.addCustomMcp({
          name: "Credential test",
          url: "https://example.com/mcp",
          auth: "oauth",
          headers: { "X-Account-Key": "account-header-secret" },
        })
      );
      key = added.pluginKey;
      await Effect.runPromise(
        service.configure(added.connectionId, {
          clientId: "first-client",
          clientSecret: "first-secret",
          scope: "read",
        })
      );
      await prisma.pluginConnection.update({
        where: { id: added.connectionId },
        data: {
          credentials: {
            clientSecret: "first-secret",
            headers: { "X-Account-Key": "account-header-secret" },
            oauth: {
              clientInformation: { client_id: "stale-client" },
              tokens: { access_token: "old-oauth-token" },
            },
          },
        },
      });
      await Effect.runPromise(
        service.configure(added.connectionId, {
          clientId: "new-client",
          clientSecret: "new-client-secret",
        })
      );
      const saved = await prisma.pluginConnection.findUniqueOrThrow({
        where: { id: added.connectionId },
      });
      expect((saved.credentials as Record<string, unknown>).oauth).toBeUndefined();
      const view = await Effect.runPromise(service.configuration.get(added.connectionId));
      expect(view.values.clientId).toBe("new-client");
      expect(view.configuredSecrets).toContain("clientSecret");
      expect(JSON.stringify(view)).not.toContain("new-client-secret");
      expect(JSON.stringify(view)).not.toContain("account-header-secret");
      const account = await Effect.runPromise(service.addAccount(added.connectionId, "second"));
      const second = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: account.id } });
      expect(second.credentials).toEqual({});
      expect(JSON.stringify(second.configuration)).not.toContain("account-header-secret");
      const bundle = importPackageArchive(
        await Effect.runPromise(service.management.exportInstalled(key))
      );
      expect(JSON.stringify(bundle)).not.toContain("account-header-secret");
      expect(JSON.stringify(bundle)).not.toContain("new-client-secret");
      await Effect.runPromise(
        service.configuration.save(added.connectionId, {
          secrets: { clientSecret: { action: "clear" } },
          headers: {},
        })
      );
      expect(
        (await Effect.runPromise(service.configuration.get(added.connectionId))).configuredSecrets
      ).not.toContain("clientSecret");
    } finally {
      if (key) await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } });
      await service.close();
      await prisma.$disconnect();
    }
  }
);
