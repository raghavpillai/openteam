import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { createPluginTemplate } from "@openteam/plugin-sdk";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "packaged OAuth keeps account tokens isolated, serializes refresh, and passes only access tokens to the computer",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const fixture = createOAuthMcpFixture();
    const origin = fixture.server.url.origin;
    const definition = createPluginTemplate(
      "packaged-mcp",
      `packaged-oauth-${crypto.randomUUID()}`
    );
    const connector = definition.connections[0]!;
    connector.auth = "oauth";
    connector.oauth = {
      clientType: "confidential",
      registration: "manual",
      tokenEndpointAuthMethod: "client_secret_post",
      shareClientCredentials: true,
      authorizationServer: {
        issuer: origin,
        authorizationUrl: `${origin}/authorize`,
        tokenUrl: `${origin}/token`,
      },
      accessTokenEnv: "PROVIDER_ACCESS_TOKEN",
    };
    connector.configuration = { command: "bun", args: ["${PLUGIN_ROOT}/connector/server.mjs"] };
    definition.setup = {
      kind: "oauth_client",
      connectionKey: connector.key,
      title: "Connect",
      description: "Test",
      documentationUrl: null,
      steps: [],
      requiredScopes: ["read"],
      fields: [
        { key: "clientId", label: "Client ID", required: true, secret: false },
        { key: "clientSecret", label: "Client secret", required: true, secret: true },
      ],
    };
    let draftId = "";
    let discoveryFailure = false;
    const configurations: Array<Record<string, any>> = [];
    const service = new PluginService(prisma, async (path, init) => {
      if (init?.method === "DELETE") return Response.json({});
      const { configuration, toolName, arguments: args } = JSON.parse(String(init?.body));
      configurations.push(configuration);
      expect(Object.keys(configuration).sort()).toEqual([
        "args",
        "command",
        "env",
        "packageBinaryFiles",
        "packageFiles",
      ]);
      expect(Object.keys(configuration.env)).toEqual(["PROVIDER_ACCESS_TOKEN", "OPENTEAM_PLUGIN_ACCOUNT_ID"]);
      expect(configuration.env.OPENTEAM_PLUGIN_ACCOUNT_ID).toBeTruthy();
      expect(JSON.stringify(configuration)).not.toContain("fixture-client-secret");
      if (path.endsWith("/discover") && discoveryFailure)
        throw new Error("Enable provider MCP access. fixture-client-secret");
      if (path.endsWith("/discover"))
        return Response.json({
          tools: [
            {
              name: "whoami",
              description: "Identity",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      const response = await fetch(fixture.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuration.env.PROVIDER_ACCESS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });
      const value = await response.json();
      return Response.json({ result: value.result });
    });
    try {
      const draft = await Effect.runPromise(
        service.management.importFiles({ "plugin.json": JSON.stringify(definition) })
      );
      draftId = draft.id;
      await Effect.runPromise(service.management.installDraft(draft.id));
      const first = await prisma.pluginConnection.findFirstOrThrow({
        where: { installation: { pluginKey: definition.key } },
      });
      const desktop = { redirectUrl: "http://127.0.0.1:55432/callback", sessionId: "desktop-test-session" };
      const configure = async (id: string, basic = false, redirectUrl?: string) => {
        const view = await Effect.runPromise(service.configuration.get(id));
        // The fixture registers a separate application per callback, as a real provider can do.
        fixture.registerClient(id, redirectUrl ?? view.callbackUrl, "fixture-client-secret");
        await Effect.runPromise(
          service.configuration.save(id, {
            values: { clientId: id },
            secrets: { clientSecret: { action: "replace", value: "fixture-client-secret" } },
            ...(basic ? { tokenEndpointAuthMethod: "client_secret_basic" as const } : {}),
          })
        );
      };
      const authorize = async (id: string, account: string, expectDiscoveryFailure = false, context?: typeof desktop) => {
        const start = await Effect.runPromise(service.authenticate(id, false, context));
        const url = new URL(start.authorizationUrl);
        if (context) expect(url.searchParams.get("redirect_uri")).toBe(context.redirectUrl);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("scope")).toBe("read");
        url.pathname = "/approve";
        const response = await fetch(url, {
          method: "POST",
          body: new URLSearchParams({ account }),
          redirect: "manual",
        });
        const callback = new URL(response.headers.get("location")!);
        const code = callback.searchParams.get("code")!,
          state = callback.searchParams.get("state")!;
        await expect(
          Effect.runPromise(service.finishAuthentication(id, code, "wrong", context))
        ).rejects.toThrow("state");
        if (expectDiscoveryFailure) {
          await expect(
            Effect.runPromise(service.finishAuthentication(id, code, state, context))
          ).rejects.toThrow("Enable provider MCP access");
          return;
        }
        await Effect.runPromise(service.finishAuthentication(id, code, state, context));
        await expect(
          Effect.runPromise(service.finishAuthentication(id, code, state, context))
        ).rejects.toThrow();
      };
      const read = (id: string) =>
        Effect.runPromise(service.testTool(id, { toolName: "whoami", arguments: {} }));
      await configure(first.id, false, desktop.redirectUrl);
      await authorize(first.id, "Account A", false, desktop);
      const second = await Effect.runPromise(service.addAccount(first.id, "second"));
      const copied = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: second.id } });
      expect((copied.credentials as any).oauth?.tokens).toBeUndefined();
      await configure(second.id, true);
      await authorize(second.id, "Account B");
      expect(fixture.observations.authMethods).toContain("client_secret_basic");
      expect(fixture.observations.authMethods).toContain("client_secret_post");
      expect(JSON.stringify(await read(first.id))).toContain("Account A");
      expect(JSON.stringify(await read(second.id))).toContain("Account B");
      const before = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: first.id } });
      const credentials = before.credentials as any;
      await prisma.pluginConnection.update({
        where: { id: first.id },
        data: {
          credentials: { ...credentials, oauth: { ...credentials.oauth, tokensExpireAt: 1 } },
        },
      });
      const count = fixture.observations.refreshes;
      const parallel = await Promise.all([read(first.id), read(first.id), read(first.id)]);
      expect(parallel.every((value) => JSON.stringify(value).includes("Account A"))).toBe(true);
      expect(fixture.observations.refreshes - count).toBe(1);
      expect(JSON.stringify(await read(second.id))).toContain("Account B");
      const after = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: first.id } });
      expect((after.credentials as any).oauth.tokens.refresh_token).not.toBe(
        credentials.oauth.tokens.refresh_token
      );
      expect((after.credentials as any).oauth.tokensExpireAt).toBeGreaterThan(Date.now());
      discoveryFailure = true;
      await authorize(second.id, "Account B", true);
      const failed = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: second.id } });
      expect(failed.status).toBe("error");
      expect(failed.statusMessage).toContain("Enable provider MCP access");
      expect(failed.statusMessage).not.toContain("fixture-client-secret");
      discoveryFailure = false;
      await Effect.runPromise(service.connect(second.id));
      expect(JSON.stringify(await read(second.id))).toContain("Account B");
      await Effect.runPromise(service.disconnect(first.id));
      const view = await Effect.runPromise(service.configuration.get(first.id));
      expect(JSON.stringify(view)).not.toContain("fixture-client-secret");
      expect(configurations.length).toBeGreaterThan(5);
    } finally {
      await service.close();
      fixture.close();
      await prisma.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
      if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
      await prisma.$disconnect();
    }
  },
  30_000
);
