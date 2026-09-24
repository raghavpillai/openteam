import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assembleUpstreamPlugin } from "@openteam/plugin-sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { Effect } from "effect";
import { pluginCatalog } from "../../src/plugins/catalog";
import { PluginService } from "../../src/services/plugin-service";
import { pluginRuntimeContext } from "../../../worker/src/plugins";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

for (const provider of ["slack", "granola"] as const) {
  test.skipIf(!databaseUrl)(
    `${provider} workflow upgrade preserves OAuth, account policy, and Bot isolation`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), `openteam-${provider}-upgrade-`));
      const previousRoot = process.env.OPENTEAM_AGENT_DATA_ROOT;
      const previousUrl = process.env.OPENTEAM_PUBLIC_URL;
      process.env.OPENTEAM_AGENT_DATA_ROOT = root;
      process.env.OPENTEAM_PUBLIC_URL = "https://openteam.example.test";
      const prisma = createPrismaClient(databaseUrl!);
      const fixture = createOAuthMcpFixture();
      const store = new AgentDataStore(prisma, { root, workspaceRoot: join(root, "workspace") });
      const service = new PluginService(prisma, undefined, store);
      let definition = structuredClone(pluginCatalog.find((plugin) => plugin.key === provider)!);
      if (provider === "granola") {
        // Synthetic source tests the deferred-install path without redistributing provider text or requiring network.
        const originals: Record<string, string> = {
          ".cursor-plugin/plugin.json": JSON.stringify({ name: "granola", version: "1.0.0" }),
          "agents/granola-engineer.md":
            "---\nname: granola-engineer\ndescription: Engineer\n---\nUse meeting context.",
          "rules/context.mdc": "---\nalwaysApply: true\n---\nUse context when relevant.",
        };
        for (const name of ["context", "prep", "review"])
          originals[`skills/granola-${name}/SKILL.md`] =
            `---\nname: granola-${name}\ndescription: Source fixture\ncustom-field: preserve\n---\nOriginal ${name} instructions.\n`;
        for (const name of ["brief", "bug-report", "gaps", "plan", "pr", "spec"])
          originals[`commands/granola-${name}.md`] =
            `---\ndescription: ${name}\n---\nUse $ARGUMENTS.`;
        definition.upstream!.files = Object.fromEntries(
          Object.entries(originals).map(([path, body]) => [
            path,
            createHash("sha256").update(body).digest("hex"),
          ])
        );
        definition = assembleUpstreamPlugin(definition, originals);
      }
      definition.key = `${provider}-upgrade-${crypto.randomUUID()}`;
      // Exercise the bundled provider's OAuth settings against a disposable server.
      definition.connections[0]!.endpoint = fixture.endpoint;
      const legacy = structuredClone(definition);
      legacy.version = provider === "slack" ? "1.0.4" : "1.0.0";
      legacy.components = provider === "slack" ? ["mcp"] : ["mcp", "skills"];
      if (provider === "slack") legacy.skills = [];
      legacy.files = {};
      delete legacy.upstream;
      const botId = crypto.randomUUID();
      let draftId = "";
      try {
        await prisma.bot.create({
          data: {
            id: botId,
            name: "Workflow tester",
            defaultDirectory: "/workspace",
            conversation: { create: {} },
          },
        });
        const draft = await Effect.runPromise(
          service.management.importFiles({ "plugin.json": JSON.stringify(legacy) })
        );
        draftId = draft.id;
        await Effect.runPromise(service.management.installDraft(draftId));
        const account = await prisma.pluginConnection.findFirstOrThrow({
          where: { installation: { pluginKey: definition.key } },
        });
        await Effect.runPromise(
          service.configuration.save(account.id, { oauthCallbackMode: "server" })
        );
        if (provider === "slack") {
          const view = await Effect.runPromise(service.configuration.get(account.id));
          fixture.registerClient("fixture-slack-client", view.callbackUrl, "fixture-slack-secret");
          await Effect.runPromise(
            service.configuration.save(account.id, {
              values: { clientId: "fixture-slack-client" },
              secrets: { clientSecret: { action: "replace", value: "fixture-slack-secret" } },
            })
          );
        }
        const auth = await Effect.runPromise(service.authenticate(account.id));
        const approval = new URL(auth.authorizationUrl);
        approval.pathname = "/approve";
        const response = await fetch(approval, {
          method: "POST",
          body: new URLSearchParams({ account: "Account A" }),
          redirect: "manual",
        });
        expect(response.status).toBe(302);
        const callback = new URL(response.headers.get("location")!);
        await Effect.runPromise(
          service.finishAuthentication(
            account.id,
            callback.searchParams.get("code")!,
            callback.searchParams.get("state")!
          )
        );
        expect(fixture.observations.authMethods).toContain(
          provider === "slack" ? "client_secret_post" : "none"
        );
        await Effect.runPromise(service.renameAccount(account.id, "work"));
        await Effect.runPromise(service.setEnablement(definition.key, botId, true, true));
        await Effect.runPromise(service.setGrant(account.id, botId, true));
        await Effect.runPromise(
          service.setPolicy(account.id, {
            botId: null,
            toolName: "echo",
            decision: "deny",
            enabled: false,
          })
        );
        const before = await prisma.pluginConnection.findUniqueOrThrow({
          where: { id: account.id },
          include: { grants: true, policies: true },
        });
        const namespaces = (await pluginRuntimeContext(prisma, botId)).dynamicNamespaces;
        await Effect.runPromise(service.management.saveDraft(draftId, definition));
        const review = await Effect.runPromise(service.management.package(definition.key));
        expect(review.update).not.toBeNull();
        await Effect.runPromise(service.management.update(definition.key, review.update!.digest));
        expect(
          (await Effect.runPromise(service.management.package(definition.key))).skillSyncStatus
        ).toBe("ready");
        const after = await prisma.pluginConnection.findUniqueOrThrow({
          where: { id: account.id },
          include: { grants: true, policies: true },
        });
        // The existing update flow requests rediscovery; it must reuse authorization.
        expect(after.status).toBe("disconnected");
        expect(after.alias).toBe("work");
        expect(after.credentials).toEqual(before.credentials);
        expect(after.configuration).toEqual(before.configuration);
        expect(after.grants).toEqual(before.grants);
        expect(after.policies).toEqual(before.policies);
        await Effect.runPromise(service.connect(account.id));
        const context = await pluginRuntimeContext(prisma, botId);
        expect(context.dynamicNamespaces).toEqual(namespaces);
        expect(context.skillInstructions).toContain("upstream");
        expect(context.pluginRuntimePackages).toHaveLength(1);
        const runtime = context.pluginRuntimePackages[0]!;
        expect(runtime.commands).toHaveLength(provider === "slack" ? 5 : 6);
        expect(runtime.agents).toHaveLength(provider === "slack" ? 0 : 1);
        expect(runtime.installPath).toEndWith("/upstream");
        const skillPath = `${definition.skills[0]!.path}/SKILL.md`;
        expect(await readFile(join(runtime.installPath, "..", skillPath), "utf8")).toBe(
          definition.files![skillPath]!
        );
        const result = await Effect.runPromise(
          service.testTool(account.id, { toolName: "whoami", arguments: {} })
        );
        expect(JSON.stringify(result)).toContain("Account A");
        // Instruction enablement and account grants remain independent after the update.
        await Effect.runPromise(service.setEnablement(definition.key, botId, true, false));
        const toolsOnly = await pluginRuntimeContext(prisma, botId);
        expect(toolsOnly.pluginRuntimePackages).toEqual([]);
        expect(toolsOnly.skillInstructions).toBe("");
        expect(toolsOnly.dynamicNamespaces).toEqual(namespaces);
        await Effect.runPromise(service.setEnablement(definition.key, botId, true, true));
        await Effect.runPromise(service.setGrant(account.id, botId, false));
        const ungranted = await pluginRuntimeContext(prisma, botId);
        expect(ungranted.pluginRuntimePackages).toHaveLength(1);
        expect(ungranted.dynamicNamespaces).toEqual([]);
        const unrelated = await pluginRuntimeContext(prisma, crypto.randomUUID());
        expect(unrelated).toEqual({
          dynamicNamespaces: [],
          skillInstructions: "",
          pluginRuntimePackages: [],
        });
      } finally {
        await service.close();
        fixture.close();
        await prisma.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
        if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
        await prisma.bot.deleteMany({ where: { id: botId } });
        await prisma.$disconnect();
        if (previousRoot === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
        else process.env.OPENTEAM_AGENT_DATA_ROOT = previousRoot;
        if (previousUrl === undefined) delete process.env.OPENTEAM_PUBLIC_URL;
        else process.env.OPENTEAM_PUBLIC_URL = previousUrl;
        await rm(root, { recursive: true, force: true });
      }
    }
  );
}
