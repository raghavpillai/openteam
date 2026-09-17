import { expect, test } from "bun:test";
import { createOpenTeamClient } from "../../../../packages/client-core/src";
import { createPluginFlowFixture } from "./fixtures/plugin-flow";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "plugin HTTP handoff resumes, cancels, expires and rejects stale callbacks without leaking provider errors",
  async () => {
    const fixture = await createPluginFlowFixture(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const client = createOpenTeamClient({ baseUrl: fixture.server.url.origin });
    try {
      const key = fixture.definitions[0]!.key;
      await client.installPlugin(key);
      const connection = (await client.pluginSettings()).installs.find(
        (row) => row.pluginKey === key
      )!.connections[0]!;
      const [first, second] = await Promise.all([
        client.authenticatePlugin(connection.id),
        client.authenticatePlugin(connection.id),
      ]);
      expect(first.authorizationUrl).toBe(second.authorizationUrl);
      expect((await client.authenticatePlugin(connection.id)).authorizationUrl).toBe(
        first.authorizationUrl
      );
      const state = new URL(first.authorizationUrl).searchParams.get("state")!;
      expect(
        (await client.pluginConnectionStatuses([connection.id])).connections[0]!
          .authorizationExpiresAt
      ).toBeTruthy();
      await client.cancelPluginAuthentication(connection.id, state);
      expect((await client.pluginConnectionStatuses([connection.id])).connections[0]).toMatchObject(
        { authorizationUrl: null, status: "needs_auth" }
      );
      const stale = await fetch(
        `${fixture.server.url.origin}/api/plugin-oauth/callback?connectionId=${connection.id}&state=${state}&code=discarded-secret`
      );
      expect(stale.status).toBe(400);
      expect(stale.headers.get("cache-control")).toBe("no-store");
      expect(stale.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await stale.text();
      expect(html).toContain("no longer active");
      expect(html).not.toContain("discarded-secret");
      const newer = await client.authenticatePlugin(connection.id);
      expect(newer.authorizationUrl).not.toBe(first.authorizationUrl);
      await expect(client.cancelPluginAuthentication(connection.id, state)).rejects.toThrow(
        "state"
      );
      expect(
        (await client.pluginConnectionStatuses([connection.id])).connections[0]!.authorizationUrl
      ).toBe(newer.authorizationUrl);
      const row = await fixture.db.pluginConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      const credentials = row.credentials as { oauth: { stateCreatedAt: number } };
      credentials.oauth.stateCreatedAt = Date.now() - 16 * 60_000;
      await fixture.db.pluginConnection.update({
        where: { id: connection.id },
        data: { credentials },
      });
      const renewed = await client.authenticatePlugin(connection.id);
      expect(renewed.authorizationUrl).not.toBe(newer.authorizationUrl);
      const approve = new URL(renewed.authorizationUrl);
      approve.pathname = "/approve";
      const response = await fetch(approve, {
        method: "POST",
        body: new URLSearchParams({ account: "Account A" }),
        redirect: "manual",
      });
      const completed = await fetch(response.headers.get("location")!);
      expect(completed.ok).toBe(true);
      expect(await completed.text()).toContain("Plugin connected");
      expect((await client.pluginConnectionStatuses([connection.id])).connections[0]).toMatchObject(
        { status: "ready", authorizationUrl: null }
      );
      await client.disconnectPlugin(connection.id);
      const rejected = await client.authenticatePlugin(connection.id);
      const deny = new URL(rejected.authorizationUrl);
      deny.pathname = "/approve";
      const denied = await fetch(deny, {
        method: "POST",
        body: new URLSearchParams({ account: "cancel" }),
        redirect: "manual",
      });
      expect(await (await fetch(denied.headers.get("location")!)).text()).toContain(
        "Authorization cancelled"
      );
      expect(
        (await client.pluginConnectionStatuses([connection.id])).connections[0]!.authorizationUrl
      ).toBeNull();
      await client.uninstallPlugin(key);
      expect((await client.pluginSettings()).installs.some((row) => row.pluginKey === key)).toBe(
        false
      );
    } finally {
      await fixture.close();
    }
  },
  20_000
);
