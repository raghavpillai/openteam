import { expect, test } from "bun:test";
import { createOpenTeamClient } from "../../../../packages/client-core/src";
import { pluginCatalog } from "@openteam/plugins";
import { createPluginFlowFixture } from "./fixtures/plugin-flow";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "resolved URL setup never exposes credential placeholders in legacy endpoints",
  async () => {
    const fixture = await createPluginFlowFixture(databaseUrl!);
    const plugin = structuredClone(pluginCatalog.find((p) => p.key === "t3-code")!);
    plugin.key = `legacy-url-${crypto.randomUUID()}`;
    plugin.connections[0]!.endpoint = "https://example.invalid/mcp?token=${token}";
    plugin.connections[0]!.auth = "token";
    plugin.setup = {
      ...plugin.setup!,
      kind: "token",
      fields: [{ key: "token", label: "Token", required: true, secret: true }],
    };
    fixture.definitions.push(plugin);
    const client = createOpenTeamClient({ baseUrl: fixture.server.url.origin });
    try {
      await client.installPlugin(plugin.key);
      const connection = (await client.pluginSettings()).installs.find(
        (p) => p.pluginKey === plugin.key
      )!.connections[0]!;
      await client.savePluginConfiguration(connection.id, {
        secrets: { token: { action: "replace", value: "synthetic-credential-value" } },
      });
      const config = await client.pluginConfiguration(connection.id);
      expect(config.endpoint).toBe(plugin.connections[0]!.endpoint);
      expect(JSON.stringify(config)).not.toContain("synthetic-credential-value");
      await client.savePluginConfiguration(connection.id, { endpoint: config.endpoint! });
      expect(
        (await fixture.db.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } }))
          .endpoint
      ).toBe(plugin.connections[0]!.endpoint);
    } finally {
      await fixture.close();
    }
  }
);

test.skipIf(!databaseUrl)(
  "T3 plugin validates URLs, authorizes public OAuth without refresh tokens, and isolates environments",
  async () => {
    const fixture = await createPluginFlowFixture(databaseUrl!, {
      callbackMode: "server",
      refreshTokens: false,
    });
    const other = createOAuthMcpFixture(0, { refreshTokens: false });
    const plugin = structuredClone(pluginCatalog.find((p) => p.key === "t3-code")!);
    plugin.key = `t3-test-${crypto.randomUUID()}`;
    plugin.connections[0]!.configuration = {
      ...plugin.connections[0]!.configuration,
      oauthCallbackMode: "server",
    };
    fixture.definitions.push(plugin);
    const client = createOpenTeamClient({ baseUrl: fixture.server.url.origin });
    const authorize = async (id: string, account: string) => {
      const started = await client.authenticatePlugin(id);
      const url = new URL(started.authorizationUrl);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      url.pathname = "/approve";
      const response = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ account }),
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      const callback = await fetch(response.headers.get("location")!);
      expect(callback.ok).toBe(true);
    };
    try {
      await client.installPlugin(plugin.key);
      const first = (await client.pluginSettings()).installs.find(
        (p) => p.pluginKey === plugin.key
      )!.connections[0]!;
      expect(first.configured).toBe(false);
      await expect(
        client.savePluginConfiguration(first.id, {
          values: { mcpUrl: "http://192.168.1.5:3773/mcp" },
        })
      ).rejects.toThrow("HTTPS");
      await expect(
        client.savePluginConfiguration(first.id, {
          values: { mcpUrl: "https://test.example/mcp#private-code" },
        })
      ).rejects.toThrow();
      await client.savePluginConfiguration(first.id, {
        values: { mcpUrl: fixture.provider.endpoint },
      });
      const settings = await client.pluginConfiguration(first.id);
      expect(settings.endpoint).toBe(fixture.provider.endpoint);
      // An advanced settings save must not replace the URL-field binding with its old resolved URL.
      await client.savePluginConfiguration(first.id, {
        endpoint: settings.endpoint!,
        values: { mcpUrl: fixture.provider.endpoint },
      });
      expect(
        (await fixture.db.pluginConnection.findUniqueOrThrow({ where: { id: first.id } })).endpoint
      ).toBe("${mcpUrl}");
      await authorize(first.id, "Account A");
      const providerText = "codex opencode code OpenTeam none";
      expect(
        JSON.stringify(
          await client.testPluginConnection(first.id, {
            toolName: "echo",
            arguments: { text: providerText },
          })
        )
      ).toContain(providerText);
      expect(
        JSON.stringify(
          await client.testPluginConnection(first.id, { toolName: "whoami", arguments: {} })
        )
      ).toContain("Account A");
      const stored = await fixture.db.pluginConnection.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect((stored.credentials as any).oauth.tokens.refresh_token).toBeUndefined();
      expect((stored.credentials as any).oauth.codeVerifier).toBeUndefined();
      expect(fixture.provider.observations.authMethods).toContain("none");

      await client.addPluginAccount(first.id, "other");
      const second = (await client.pluginSettings()).installs
        .find((p) => p.pluginKey === plugin.key)!
        .connections.find((c) => c.alias === "other")!;
      await client.savePluginConfiguration(second.id, { values: { mcpUrl: other.endpoint } });
      await authorize(second.id, "Account B");
      expect(
        JSON.stringify(
          await client.testPluginConnection(second.id, { toolName: "whoami", arguments: {} })
        )
      ).toContain("Account B");
      expect(
        JSON.stringify(
          await client.testPluginConnection(first.id, { toolName: "whoami", arguments: {} })
        )
      ).toContain("Account A");
      const row = await fixture.db.pluginConnection.findUniqueOrThrow({ where: { id: second.id } });
      expect((row.credentials as any).oauth.tokens.access_token).not.toBe(
        (stored.credentials as any).oauth.tokens.access_token
      );
      await client.savePluginConfiguration(first.id, { values: { mcpUrl: other.endpoint } });
      const changed = await fixture.db.pluginConnection.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect((changed.credentials as any).oauth).toBeUndefined();
      expect(changed.status).toBe("disconnected");
      await expect(
        client.savePluginConfiguration(second.id, { endpoint: "http://192.168.0.1/mcp" })
      ).rejects.toThrow("HTTPS");
    } finally {
      other.close();
      await fixture.close();
    }
  },
  30_000
);
