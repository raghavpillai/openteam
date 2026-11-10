import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { pluginCatalog } from "@openteam/plugins";
import { Effect } from "effect";
import { pluginRuntimeContext } from "../../../worker/src/plugins";
import { PluginService } from "../../src/services/plugin-service";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "Ramp installs its playbooks and routes an authenticated MCP call through the Bot namespace",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "ramp-plugin-"));
    const provider = createOAuthMcpFixture();
    const store = new AgentDataStore(db, { root, workspaceRoot: join(root, "workspace") });
    const service = new PluginService(db, undefined, store);
    const definition = structuredClone(pluginCatalog.find((plugin) => plugin.key === "ramp")!);
    definition.key = `ramp-${crypto.randomUUID()}`;
    definition.connections[0]!.endpoint = provider.endpoint;
    definition.connections[0]!.configuration = { oauthCallbackMode: "server" };
    Object.assign(service, {
      catalog: async () => [definition],
      definition: async (key: string) => (key === definition.key ? definition : undefined),
    });
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const previousRoot = process.env.OPENTEAM_AGENT_DATA_ROOT;
    process.env.OPENTEAM_AGENT_DATA_ROOT = root;
    const authorize = async (id: string, account: string) => {
      const started = await Effect.runPromise(service.authenticate(id));
      const url = new URL(started.authorizationUrl);
      url.pathname = "/approve";
      const response = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ account }),
        redirect: "manual",
      });
      const callback = new URL(response.headers.get("location")!);
      await Effect.runPromise(
        service.finishAuthentication(
          id,
          callback.searchParams.get("code")!,
          callback.searchParams.get("state")!
        )
      );
    };
    try {
      await db.bot.create({
        data: {
          id: botId,
          name: "Ramp test",
          defaultDirectory: join(root, "bot"),
          status: "active",
          onboardingStatus: "completed",
          conversation: { create: { id: conversationId } },
        },
      });
      await db.run.create({
        data: {
          id: runId,
          botId,
          conversationId,
          userMessageId: crypto.randomUUID(),
          status: "running",
        },
      });
      const installation = await Effect.runPromise(service.install(definition.key));
      const first = await db.pluginConnection.findFirstOrThrow({
        where: { installationId: installation.id },
      });
      expect(first).toMatchObject({
        connectorKey: "ramp",
        authType: "oauth",
        status: "needs_auth",
      });
      const cache = JSON.parse(await readFile(join(root, "plugin-skills/cache.json"), "utf8"));
      const installedPath = cache.packages.find(
        (entry: { pluginId: string }) => entry.pluginId === definition.key
      ).installPath;
      expect(
        cache.skills.filter((entry: { pluginId: string }) => entry.pluginId === definition.key)
      ).toHaveLength(definition.skills.length);
      const reference = "upstream/plugins/ramp/skills/ramp-agentic-purchase/browser-checkout.md";
      expect(await readFile(join(installedPath, reference), "utf8")).toBe(
        definition.files![reference]!
      );
      expect(
        await readFile(join(installedPath, "skills/ramp-openteam/SKILL.md"), "utf8")
      ).toBe(definition.files!["skills/ramp-openteam/SKILL.md"]!);

      await authorize(first.id, "Ramp account");
      const context = await pluginRuntimeContext(db, botId);
      expect(
        context.pluginRuntimePackages.find((pkg) => pkg.key === definition.key)?.rules
      ).toMatchObject([{ name: "ramp-openteam", alwaysApply: true }]);
      const namespace = context.dynamicNamespaces.find((entry) =>
        entry.tools.some((tool) => tool.connectionId === first.id)
      )!;
      const result = await service.invoke({
        connectionId: first.id,
        namespace: namespace.name,
        botId,
        runId,
        callId: crypto.randomUUID(),
        toolName: "whoami",
        arguments: {},
      });
      expect(JSON.stringify(result)).toContain("Ramp account");
    } finally {
      if (previousRoot === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
      else process.env.OPENTEAM_AGENT_DATA_ROOT = previousRoot;
      await service.close();
      provider.close();
      await db.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
      await db.run.deleteMany({ where: { id: runId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.conversation.deleteMany({ where: { id: conversationId } });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
