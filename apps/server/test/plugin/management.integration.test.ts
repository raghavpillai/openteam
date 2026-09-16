import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { importPackageArchive } from "@openteam/plugin-sdk/archive";
import { createPluginTemplate } from "@openteam/plugin-sdk";
import { pluginCatalog } from "../../src/plugins/catalog";
import { PluginService } from "../../src/services/plugin-service";
import { pluginRuntimeContext } from "../../../worker/src/plugins";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!databaseUrl);

integration(
  "management preserves accounts, policy and snapshots through configuration, discovery and upgrades",
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
    const base = structuredClone(pluginCatalog[0]!);
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
        await Effect.runPromise(service.setGrant(connection.id, botId, true));
      }
      const initialNamespaces = await service.dynamicNamespaces(botId);
      expect(new Set(initialNamespaces.map((entry) => entry.name)).size).toBe(2);
      await Effect.runPromise(service.renameAccount(first.id, "renamed"));
      const renamedNamespaces = await service.dynamicNamespaces(botId);
      expect(renamedNamespaces.map(entry=>entry.name)).not.toEqual(initialNamespaces.map(entry=>entry.name));
      expect(renamedNamespaces.find(entry=>entry.tools.some(tool=>tool.connectionId===first.id))?.name).toContain("__72656e616d6564");
      await Effect.runPromise(
        service.setPolicy(first.id, {
          botId: null,
          toolName: "echo",
          decision: "allow",
          enabled: false,
        })
      );
      await Effect.runPromise(service.connect(first.id));
      expect(
        (await service.dynamicNamespaces(botId))[0]?.tools.some(
          (tool) => tool.connectionId === first.id && tool.name === "echo"
        )
      ).toBe(false);
      const projected = await pluginRuntimeContext(prisma, botId);
      expect(
        projected.dynamicNamespaces
          .flatMap((entry) => entry.tools)
          .some((tool) => tool.connectionId === first.id && tool.name === "echo")
      ).toBe(false);
      await expect(
        service.invoke({
          connectionId: first.id,
          botId,
          runId,
          callId: crypto.randomUUID(),
          toolName: "echo",
          arguments: { text: "denied" },
        })
      ).rejects.toThrow("denied");
      const pending = crypto.randomUUID();
      await expect(
        service.invoke({
          connectionId: first.id,
          botId,
          runId,
          callId: pending,
          toolName: "remember_note",
          arguments: { note: "Must not execute after revoke" },
        })
      ).rejects.toThrow("approval");
      await Effect.runPromise(service.setGrant(first.id, botId, false));
      await expect(service.resolveInvocation(pending, "accept")).rejects.toThrow("revoked");
      expect(
        await prisma.pluginActivity.count({
          where: { connectionId: first.id, kind: "fixture.note" },
        })
      ).toBe(0);
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
        include: { policies: true },
      });
      expect(updated.alias).toBe("renamed");
      expect(updated.policies.find((policy) => policy.toolName === "echo")?.enabled).toBe(false);
      expect((await Effect.runPromise(service.management.package(key))).definition.version).toBe(
        "1.1.0"
      );
      await Effect.runPromise(service.management.update(key, "", true));
      expect((await Effect.runPromise(service.management.package(key))).definition.version).toBe(
        base.version
      );
      await Effect.runPromise(service.management.setMode(key, "required"));
      await expect(Effect.runPromise(service.uninstall(key))).rejects.toThrow("required");
      await expect(Effect.runPromise(service.setEnablement(key, botId, false))).rejects.toThrow(
        "required"
      );
      await Effect.runPromise(service.management.setMode(key, "disabled"));
      expect(await service.dynamicNamespaces(botId)).toEqual([]);
      await Effect.runPromise(service.management.setMode(key, "optional"));
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

integration(
  "sources refresh in place, installed snapshots survive removal, and private skills stay scoped",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const service = new PluginService(prisma);
    const key = `source-test-${crypto.randomUUID()}`;
    const botId = crypto.randomUUID();
    let revision = "first";
    let advertisedKey = key;
    const base = structuredClone(
      pluginCatalog.find((plugin) => plugin.key === "research-playbook")!
    );
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          schemaVersion: 1,
          revision,
          plugins: [
            {
              ...base,
              key: advertisedKey,
              name: "Source fixture",
              version: revision === "first" ? "1.0.0" : "1.1.0",
            },
          ],
        }),
    });
    let sourceId = "";
    let skillId = "";
    try {
      sourceId = (
        await Effect.runPromise(
          service.management.addSource(server.url.toString(), "Fixture catalog")
        )
      ).id;
      await expect(
        Effect.runPromise(service.management.addSource(new URL("duplicate", server.url).toString()))
      ).rejects.toThrow("already belongs");
      await Effect.runPromise(service.install(key));
      revision = "second";
      await Effect.runPromise(service.management.refreshSource(sourceId));
      expect(
        (await Effect.runPromise(service.management.package(key))).update?.definition.version
      ).toBe("1.1.0");
      advertisedKey = base.key;
      await expect(Effect.runPromise(service.management.refreshSource(sourceId))).rejects.toThrow(
        "already belongs"
      );
      expect(
        (await Effect.runPromise(service.management.package(key))).update?.definition.version
      ).toBe("1.1.0");
      advertisedKey = key;
      await Effect.runPromise(
        service.management.updateSource(sourceId, server.url.toString(), "Renamed catalog")
      );
      expect(
        (await Effect.runPromise(service.management.overview())).sources.find(
          (s) => s.id === sourceId
        )?.name
      ).toBe("Renamed catalog");
      await Effect.runPromise(service.management.deleteSource(sourceId));
      sourceId = "";
      expect((await Effect.runPromise(service.management.package(key))).definition.version).toBe(
        "1.0.0"
      );
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Private skill tester",
          defaultDirectory: "/workspace/private-test",
          conversation: { create: {} },
        },
      });
      skillId = (
        await Effect.runPromise(
          service.management.saveSkill(null, {
            name: `private-${botId}`,
            description: "Private instructions",
            body: "Special instructions for one bot",
            enabledBotIds: [botId],
          })
        )
      ).id;
      expect(await service.skillInstructions(botId)).toContain("Special instructions for one bot");
      expect(await service.skillInstructions(crypto.randomUUID())).not.toContain(
        "Special instructions for one bot"
      );
      expect((await pluginRuntimeContext(prisma, botId)).skillInstructions).toContain(
        "Special instructions for one bot"
      );
    } finally {
      server.stop(true);
      if (sourceId) await prisma.pluginSource.deleteMany({ where: { id: sourceId } });
      if (skillId) await prisma.pluginPrivateSkill.deleteMany({ where: { id: skillId } });
      await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } });
      await prisma.bot.deleteMany({ where: { id: botId } });
      await service.close();
      await prisma.$disconnect();
    }
  }
);

integration("package defaults and changed requirements survive install and updates", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const service = new PluginService(prisma);
  const definition = createPluginTemplate("packaged-mcp", `defaults-${crypto.randomUUID()}`);
  let draftId = "";
  try {
    const draft = await Effect.runPromise(
      service.management.importFiles({ "plugin.json": JSON.stringify(definition) })
    );
    draftId = draft.id;
    await Effect.runPromise(service.management.installDraft(draft.id));
    const installation = await prisma.pluginInstallation.findUniqueOrThrow({
      where: { pluginKey: definition.key },
      include: { connections: true },
    });
    const connection = installation.connections[0]!;
    expect(connection).toMatchObject({ status: "disconnected", statusMessage: null });
    expect(
      (await Effect.runPromise(service.configuration.get(connection.id))).values.GREETING
    ).toBe("Hello");
    const updated = {
      ...definition,
      version: "1.1.0",
      setupFields: [
        ...(definition.setupFields ?? []),
        {
          key: "REGION",
          label: "Region",
          type: "string" as const,
          default: "east",
          required: false,
          secret: false,
        },
        { key: "WORKSPACE", label: "Workspace", required: true, secret: false },
      ],
    };
    await Effect.runPromise(service.management.saveDraft(draft.id, updated));
    const review = await Effect.runPromise(service.management.package(definition.key));
    await Effect.runPromise(service.management.update(definition.key, review.update!.digest));
    expect((await Effect.runPromise(service.configuration.get(connection.id))).values.REGION).toBe(
      "east"
    );
    await expect(Effect.runPromise(service.connect(connection.id))).rejects.toThrow(
      "Workspace is required"
    );
    await Effect.runPromise(
      service.configuration.save(connection.id, { values: { WORKSPACE: "test workspace" } })
    );
    expect(
      (await Effect.runPromise(service.configuration.get(connection.id))).values
    ).toMatchObject({ REGION: "east", WORKSPACE: "test workspace", GREETING: "Hello" });
    await Effect.runPromise(service.management.update(definition.key, "", true));
    expect(
      (await Effect.runPromise(service.management.package(definition.key))).definition.version
    ).toBe("1.0.0");
  } finally {
    await service.close();
    await prisma.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
    if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
    await prisma.$disconnect();
  }
});

integration("uninstall cancels pending approvals before removing the connection", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const service = new PluginService(prisma);
  const botId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const callId = crypto.randomUUID();
  const definition = {
    ...structuredClone(pluginCatalog[0]!),
    key: `pending-${crypto.randomUUID()}`,
  };
  let draftId = "";
  try {
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Approval fixture",
        defaultDirectory: "/workspace/approval-test",
        conversation: { create: { id: conversationId } },
      },
    });
    await prisma.run.create({
      data: { id: runId, botId, conversationId, userMessageId: crypto.randomUUID() },
    });
    const draft = await Effect.runPromise(
      service.management.importFiles({ "plugin.json": JSON.stringify(definition) })
    );
    draftId = draft.id;
    await Effect.runPromise(service.management.installDraft(draft.id));
    const connection = await prisma.pluginConnection.findFirstOrThrow({
      where: { installation: { pluginKey: definition.key } },
    });
    await Effect.runPromise(service.connect(connection.id));
    await Effect.runPromise(service.setGrant(connection.id, botId, true));
    await expect(
      service.invoke({
        connectionId: connection.id,
        botId,
        runId,
        callId,
        toolName: "remember_note",
        arguments: { note: "Must never execute" },
      })
    ).rejects.toThrow("approval");
    const approval = await prisma.approval.findUniqueOrThrow({
      where: { upstreamRequestId: `plugin:${callId}` },
    });
    await Effect.runPromise(service.uninstall(definition.key));
    expect(await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).toMatchObject({
      status: "cancelled",
      decision: "cancel",
    });
    await expect(service.resolveInvocation(callId, "accept")).rejects.toThrow();
    expect(await prisma.pluginConnection.findUnique({ where: { id: connection.id } })).toBeNull();
  } finally {
    await service.close();
    await prisma.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
    if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
  }
});

integration(
  "a disconnected account cannot be resurrected by stale discovery; empty tools and outage are distinct",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    let release!: () => void;
    let announce!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let behavior = "delayed";
    const service = new PluginService(prisma, async (_path, init) => {
      if (init?.method === "DELETE") return Response.json({ stopped: true });
      if (behavior === "delayed") {
        announce();
        await held;
      }
      if (behavior === "outage")
        return Response.json({ error: "Fixture computer offline" }, { status: 503 });
      return Response.json({ tools: [] });
    });
    let key = "";
    try {
      const added = await Effect.runPromise(
        service.addCustomMcp({
          name: "Delayed discovery",
          command: "fixture",
          args: ["argument with spaces"],
          cwd: "/workspace",
        })
      );
      key = added.pluginKey;
      const connecting = Effect.runPromise(service.connect(added.connectionId)).then(
        () => "connected",
        () => "superseded"
      );
      await started;
      await Effect.runPromise(service.disconnect(added.connectionId));
      release();
      expect(await connecting).toBe("superseded");
      expect(
        (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: added.connectionId } }))
          .status
      ).toBe("disconnected");
      behavior = "empty";
      expect(await Effect.runPromise(service.connect(added.connectionId))).toMatchObject({
        status: "ready",
        toolCount: 0,
      });
      behavior = "outage";
      await expect(Effect.runPromise(service.restart(added.connectionId))).rejects.toThrow(
        "Fixture computer offline"
      );
      expect(
        await prisma.pluginConnection.findUniqueOrThrow({ where: { id: added.connectionId } })
      ).toMatchObject({ status: "error" });
    } finally {
      release();
      await service.close();
      if (key) await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } });
      await prisma.$disconnect();
    }
  }
);
