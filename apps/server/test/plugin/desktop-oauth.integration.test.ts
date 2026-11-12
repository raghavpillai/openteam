import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createOpenTeamClient } from "../../../../packages/client-core/src";
import { DesktopPluginOAuth, type PluginOAuthResult } from "../../../desktop/src/main/plugin-oauth";
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
  return new URL(response.headers.get("location")!);
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test.skipIf(!databaseUrl)(
  "desktop listener → backend routes → provider → database completes and refreshes without desktop",
  async () => {
    const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "desktop" });
    const client = createOpenTeamClient({ baseUrl: f.server.url.origin });
    const results: PluginOAuthResult[] = [];
    const desktop = new DesktopPluginOAuth((result) => results.push(result));
    try {
      const key = f.definitions[0]!.key;
      await client.installPlugin(key);
      const connection = (await client.pluginSettings()).installs.find(
        (row) => row.pluginKey === key
      )!.connections[0]!;
      const started = await desktop.start("backend-one", connection.id, client);
      const authorizeUrl = new URL(started.authorizationUrl);
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = await approve(started.authorizationUrl);
      expect(callback.origin).not.toBe(f.server.url.origin);
      expect(callback.pathname).toBe("/callback");
      const response = await fetch(callback);
      expect(response.ok).toBe(true);
      await waitFor(() => results.length === 1);
      expect(results[0]?.status).toBe("ready");
      desktop.closeAll();
      const row = await f.db.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } });
      const credentials = row.credentials as any;
      expect(credentials.oauth.tokens.refresh_token).toBeTruthy();
      expect(credentials.oauth.codeVerifier).toBeUndefined();
      expect(credentials.oauth.callbackSessionId).toBeUndefined();
      expect(row.status).toBe("ready");
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
      const result = await client.testPluginConnection(connection.id, {
        toolName: "whoami",
        arguments: {},
      });
      expect(JSON.stringify(result)).toContain("Account A");
      expect(f.provider.observations.refreshes).toBeGreaterThan(0);
      await expect(fetch(callback)).rejects.toThrow();

      const restart = await desktop.start("backend-one", connection.id, client, true);
      const denial = await approve(restart.authorizationUrl, "cancel");
      await fetch(denial);
      await waitFor(() => results.length === 2);
      expect(results[1]?.status).toBe("cancelled");
      expect(
        (await client.pluginConnectionStatuses([connection.id])).connections[0]?.authorizationUrl
      ).toBeNull();
    } finally {
      desktop.closeAll();
      await f.close();
    }
  },
  20_000
);

test.skipIf(!databaseUrl)(
  "desktop callback is bound to session/redirect/state; public callback cannot redeem it; duplicate completion claims once",
  async () => {
    const f = await createPluginFlowFixture(databaseUrl!);
    const client = createOpenTeamClient({ baseUrl: f.server.url.origin });
    try {
      const key = f.definitions[0]!.key;
      await client.installPlugin(key);
      const connection = (await client.pluginSettings()).installs.find(
        (row) => row.pluginKey === key
      )!.connections[0]!;
      const context = { redirectUrl: "http://127.0.0.1:54321/callback", sessionId: "session-A" };
      const started = await Effect.runPromise(
        f.service.authenticate(connection.id, false, context)
      );
      const callback = await approve(started.authorizationUrl);
      const input = {
        redirectUrl: context.redirectUrl,
        state: callback.searchParams.get("state")!,
        code: callback.searchParams.get("code")!,
      };
      await expect(client.finishPluginAuthentication(connection.id, input)).rejects.toThrow(
        "different session"
      );
      await expect(
        Effect.runPromise(f.service.finishDesktopAuthentication(connection.id, input, "session-B"))
      ).rejects.toThrow("different session");
      await expect(
        Effect.runPromise(
          f.service.finishDesktopAuthentication(
            connection.id,
            { ...input, redirectUrl: "http://127.0.0.1:54322/callback" },
            "session-A"
          )
        )
      ).rejects.toThrow("different session");
      await expect(
        Effect.runPromise(
          f.service.finishDesktopAuthentication(
            connection.id,
            { ...input, iss: "https://wrong.example" },
            "session-A"
          )
        )
      ).rejects.toThrow("issuer");
      await expect(
        Effect.runPromise(
          f.service.finishDesktopAuthentication(
            connection.id,
            { ...input, state: "wrong" },
            "session-A"
          )
        )
      ).rejects.toThrow("state");
      const publicCallback = new URL(`${f.server.url.origin}/api/v0/plugin-oauth/callback`);
      publicCallback.search = new URLSearchParams({
        connectionId: connection.id,
        code: input.code,
        state: input.state,
      }).toString();
      expect((await fetch(publicCallback)).status).toBe(400);
      const completions = await Promise.allSettled([
        Effect.runPromise(f.service.finishDesktopAuthentication(connection.id, input, "session-A")),
        Effect.runPromise(f.service.finishDesktopAuthentication(connection.id, input, "session-A")),
      ]);
      expect(completions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(f.provider.observations.authMethods).toHaveLength(1);
      await expect(
        Effect.runPromise(f.service.finishDesktopAuthentication(connection.id, input, "session-A"))
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
  20_000
);
