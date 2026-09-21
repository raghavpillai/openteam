import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createOpenTeamClient } from "../../../../packages/client-core/src";
import { MANUAL_OAUTH_REDIRECT } from "../../src/plugins/oauth-callback";
import { createPluginFlowFixture } from "./fixtures/plugin-flow";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
async function approve(authorizationUrl: string, account = "Account A") {
  const url = new URL(authorizationUrl);
  url.pathname = "/approve";
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams({ account }),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  return response.headers.get("location")!;
}

test.skipIf(!databaseUrl)(
  "HTTP defaults to manual completion through the authenticated API and refreshes on the server",
  async () => {
    const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "auto" });
    const client = createOpenTeamClient({ baseUrl: f.server.url.origin });
    try {
      const key = f.definitions[0]!.key;
      await client.installPlugin(key);
      const connection = (await client.pluginSettings()).installs.find(
        (row) => row.pluginKey === key
      )!.connections[0]!;
      expect(connection).toMatchObject({
        configured: true,
        setupPhase: "ready_to_authorize",
        oauthCallbackMode: "manual",
      });
      const started = await client.authenticatePlugin(connection.id);
      const auth = new URL(started.authorizationUrl);
      expect(auth.searchParams.get("redirect_uri")).toBe(MANUAL_OAUTH_REDIRECT);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect((await client.pluginConnectionStatuses([connection.id])).connections[0]).toMatchObject(
        { setupPhase: "authorization_pending", oauthCallbackMode: "manual" }
      );
      const callback = await approve(started.authorizationUrl);
      const invalidBody = await fetch(
        `${f.server.url.origin}/api/v0/plugin-connections/${connection.id}/authenticate/manual`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callbackUrl: `${callback}&sensitive-marker=${"a".repeat(17_000)}`,
          }),
        }
      );
      expect(invalidBody.status).toBe(400);
      expect(await invalidBody.text()).not.toContain("sensitive-marker");
      const publicAttempt = await fetch(
        `${f.server.url.origin}/api/v0/plugin-oauth/callback?${new URL(callback).searchParams}`
      );
      expect(publicAttempt.status).toBe(400);
      await expect(
        client.finishManualPluginAuthentication(
          connection.id,
          callback.replace("state=", "state=wrong")
        )
      ).rejects.toThrow("state");
      const completions = await Promise.allSettled([
        client.finishManualPluginAuthentication(connection.id, callback),
        client.finishManualPluginAuthentication(connection.id, callback),
      ]);
      expect(completions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await expect(
        client.finishManualPluginAuthentication(connection.id, callback)
      ).rejects.toThrow();
      const status = (await client.pluginConnectionStatuses([connection.id])).connections[0]!;
      expect(status).toMatchObject({
        status: "ready",
        setupPhase: "connected",
        authorizationUrl: null,
      });
      const row = await f.db.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } });
      const credentials = row.credentials as any;
      expect(credentials.oauth.tokens.refresh_token).toBeTruthy();
      expect(credentials.oauth.codeVerifier).toBeUndefined();
      expect(JSON.stringify(await client.pluginSettings())).not.toContain(
        credentials.oauth.tokens.refresh_token
      );
      await f.db.pluginConnection.update({
        where: { id: connection.id },
        data: {
          credentials: { ...credentials, oauth: { ...credentials.oauth, tokensExpireAt: 1 } },
        },
      });
      f.provider.expireTokens();
      await client.restartPluginConnection(connection.id);
      expect(f.provider.observations.refreshes).toBeGreaterThan(0);
      expect(
        JSON.stringify(
          await client.testPluginConnection(connection.id, { toolName: "whoami", arguments: {} })
        )
      ).toContain("Account A");
    } finally {
      await f.close();
    }
  },
  20_000
);

test.skipIf(!databaseUrl)(
  "manual completion is session-bound, expires, rejects issuer mismatch, and handles cancellation",
  async () => {
    const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "auto" });
    const client = createOpenTeamClient({ baseUrl: f.server.url.origin });
    try {
      const key = f.definitions[0]!.key;
      await client.installPlugin(key);
      const id = (await client.pluginSettings()).installs.find((row) => row.pluginKey === key)!
        .connections[0]!.id;
      const started = await Effect.runPromise(
        f.service.authenticate(id, false, undefined, "phone")
      );
      const callback = await approve(started.authorizationUrl);
      await expect(
        Effect.runPromise(f.service.finishManualAuthentication(id, callback, "laptop"))
      ).rejects.toThrow("session");
      await expect(
        Effect.runPromise(
          f.service.finishManualAuthentication(
            id,
            `${callback}&iss=https%3A%2F%2Fwrong.test`,
            "phone"
          )
        )
      ).rejects.toThrow("issuer");
      const row = await f.db.pluginConnection.findUniqueOrThrow({ where: { id } });
      const credentials = row.credentials as any;
      await f.db.pluginConnection.update({
        where: { id },
        data: {
          credentials: {
            ...credentials,
            oauth: { ...credentials.oauth, stateCreatedAt: Date.now() - 16 * 60_000 },
          },
        },
      });
      await expect(
        Effect.runPromise(f.service.finishManualAuthentication(id, callback, "phone"))
      ).rejects.toThrow("state");
      const renewed = await client.authenticatePlugin(id);
      const denied = await approve(renewed.authorizationUrl, "cancel");
      await client.finishManualPluginAuthentication(id, denied);
      expect((await client.pluginConnectionStatuses([id])).connections[0]).toMatchObject({
        authorizationUrl: null,
        setupPhase: "ready_to_authorize",
      });
      const retry = await client.authenticatePlugin(id);
      await client.cancelPluginAuthentication(
        id,
        new URL(retry.authorizationUrl).searchParams.get("state")!
      );
      await expect(
        client.finishManualPluginAuthentication(id, await approve(retry.authorizationUrl))
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
  20_000
);

test.skipIf(!databaseUrl)(
  "HTTPS selects a stable deployment callback and resolves the connection from state",
  async () => {
    const f = await createPluginFlowFixture(databaseUrl!, {
      publicUrl: "https://openteam.example.test",
      callbackMode: "auto",
    });
    const client = createOpenTeamClient({ baseUrl: f.server.url.origin });
    try {
      const key = f.definitions[0]!.key;
      await client.installPlugin(key);
      const id = (await client.pluginSettings()).installs.find((row) => row.pluginKey === key)!
        .connections[0]!.id;
      const started = await client.authenticatePlugin(id);
      expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
        "https://openteam.example.test/api/v0/plugin-oauth/callback"
      );
      const callback = new URL(await approve(started.authorizationUrl));
      expect(callback.searchParams.has("connectionId")).toBe(false);
      await expect(client.finishManualPluginAuthentication(id, callback.href)).rejects.toThrow(
        "session"
      );
      const response = await fetch(new URL(callback.pathname + callback.search, f.server.url));
      expect(response.ok).toBe(true);
      expect(await response.text()).toContain("Plugin connected");
      expect((await client.pluginConnectionStatuses([id])).connections[0]?.setupPhase).toBe(
        "connected"
      );
    } finally {
      await f.close();
    }
  },
  20_000
);

test.skipIf(!databaseUrl)(
  "provider setup is distinct from installation and unsupported manual callbacks are blocked",
  async () => {
    const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "auto" });
    const client = createOpenTeamClient({ baseUrl: f.server.url.origin });
    try {
      const definition = f.definitions[1]!;
      definition.connections[0]!.oauth = {
        clientType: "confidential",
        registration: "manual",
        supportsLoopbackRedirect: false,
      };
      await client.installPlugin(definition.key);
      const connection = (await client.pluginSettings()).installs.find(
        (row) => row.pluginKey === definition.key
      )!.connections[0]!;
      expect(connection.setupPhase).toBe("provider_setup_required");
      expect(
        await client.savePluginConfiguration(connection.id, {
          values: { clientId: "synthetic-client" },
        })
      ).toMatchObject({ configured: false });
      expect(
        await client.savePluginConfiguration(connection.id, {
          secrets: { clientSecret: { action: "replace", value: "synthetic-secret" } },
        })
      ).toMatchObject({ configured: true });
      expect(await client.pluginConfiguration(connection.id)).toMatchObject({
        setupPhase: "ready_to_authorize",
        manualCallbackSupported: false,
      });
      await expect(client.authenticatePlugin(connection.id)).rejects.toThrow("HTTPS");
      expect(
        (await client.pluginConnectionStatuses([connection.id])).connections[0]?.authorizationUrl
      ).toBeNull();
    } finally {
      await f.close();
    }
  },
  20_000
);
