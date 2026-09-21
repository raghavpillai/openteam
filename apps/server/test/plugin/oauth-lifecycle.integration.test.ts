import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "OAuth lifecycle covers DCR, PKCE, independent accounts, refresh, cancellation and live tool changes",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const service = new PluginService(prisma);
    const fixture = createOAuthMcpFixture();
    let key = "";
    const authorize = async (id: string, account = "Account A") => {
      const start = await Effect.runPromise(service.authenticate(id));
      const approval = new URL(start.authorizationUrl);
      approval.pathname = "/approve";
      const response = await fetch(approval, {
        method: "POST",
        body: new URLSearchParams({ account }),
        redirect: "manual",
      });
      const callback = new URL(response.headers.get("location")!);
      if (account === "cancel")
        return Effect.runPromise(
          service.cancelAuthentication(id, callback.searchParams.get("state")!)
        );
      await expect(
        Effect.runPromise(
          service.finishAuthentication(id, callback.searchParams.get("code")!, "wrong-state")
        )
      ).rejects.toThrow("state");
      return Effect.runPromise(
        service.finishAuthentication(
          id,
          callback.searchParams.get("code")!,
          callback.searchParams.get("state")!
        )
      );
    };
    try {
      const added = await Effect.runPromise(
        service.addCustomMcp({ name: "OAuth fixture", url: fixture.endpoint, auth: "oauth" })
      );
      key = added.pluginKey;
      await Effect.runPromise(service.configuration.save(added.connectionId, { oauthCallbackMode: "server" }));
      await authorize(added.connectionId);
      let connection = await prisma.pluginConnection.findUniqueOrThrow({
        where: { id: added.connectionId },
      });
      expect(connection.status).toBe("ready");
      expect((connection.toolSnapshot as Array<{ name: string }>).map((tool) => tool.name)).toEqual(
        ["echo", "whoami"]
      );
      expect((connection.credentials as { oauth: { state?: string } }).oauth.state).toBeUndefined();
      const first = await Effect.runPromise(
        service.testTool(added.connectionId, { toolName: "whoami", arguments: {} })
      );
      expect(JSON.stringify(first)).toContain("Account A");
      const second = await Effect.runPromise(
        service.addAccount(added.connectionId, "second-account")
      );
      await authorize(second.id, "Account B");
      expect(
        JSON.stringify(
          await Effect.runPromise(
            service.testTool(second.id, { toolName: "whoami", arguments: {} })
          )
        )
      ).toContain("Account B");
      expect(
        JSON.stringify(
          await Effect.runPromise(
            service.testTool(added.connectionId, { toolName: "whoami", arguments: {} })
          )
        )
      ).toContain("Account A");
      fixture.expireTokens();
      expect(
        JSON.stringify(
          await Effect.runPromise(
            service.testTool(added.connectionId, { toolName: "whoami", arguments: {} })
          )
        )
      ).toContain("Account A");
      expect(fixture.observations.refreshes).toBeGreaterThan(0);
      await Effect.runPromise(
        service.setPolicy(added.connectionId, {
          botId: null,
          toolName: "echo",
          decision: "prompt",
          enabled: false,
        })
      );
      fixture.notifyToolsChanged();
      for (let attempt = 0; attempt < 60; attempt++) {
        connection = await prisma.pluginConnection.findUniqueOrThrow({
          where: { id: added.connectionId },
        });
        if (JSON.stringify(connection.toolSnapshot).includes("new_tool")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(JSON.stringify(connection.toolSnapshot)).toContain("new_tool");
      expect(
        await prisma.pluginToolPolicy.findFirst({
          where: { connectionId: added.connectionId, toolName: "echo", botId: null },
        })
      ).toMatchObject({ decision: "prompt", enabled: false });
      await authorize(second.id, "cancel");
      expect(
        await prisma.pluginConnection.findUniqueOrThrow({ where: { id: second.id } })
      ).toMatchObject({
        status: "needs_auth",
        statusMessage: "Authorization was cancelled. You can try again when ready.",
      });
      const abandoned = await Effect.runPromise(service.authenticate(second.id));
      const abandonedState = new URL(abandoned.authorizationUrl).searchParams.get("state")!;
      await Effect.runPromise(service.disconnect(second.id));
      await expect(
        Effect.runPromise(service.finishAuthentication(second.id, "old-code", abandonedState))
      ).rejects.toThrow("state");
      await expect(
        Effect.runPromise(service.cancelAuthentication(second.id, abandonedState))
      ).rejects.toThrow("state");
      expect(
        (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: second.id } })).status
      ).toBe("disconnected");
      const view = await Effect.runPromise(service.configuration.get(second.id));
      fixture.registerClient("manual-client", view.callbackUrl, "manual-client-secret");
      await Effect.runPromise(
        service.configuration.save(second.id, {
          values: { clientId: "manual-client" },
          secrets: { clientSecret: { action: "replace", value: "manual-client-secret" } },
          tokenEndpointAuthMethod: "client_secret_post",
        })
      );
      await authorize(second.id, "Account B");
      expect(fixture.observations.authMethods).toContain("client_secret_post");
      await Effect.runPromise(
        service.configuration.save(second.id, { tokenEndpointAuthMethod: "client_secret_basic" })
      );
      await authorize(second.id, "Account B");
      expect(fixture.observations.authMethods).toContain("client_secret_basic");
      await Effect.runPromise(
        service.configuration.save(second.id, {
          secrets: { clientSecret: { action: "replace", value: "wrong-secret" } },
        })
      );
      await expect(authorize(second.id)).rejects.toThrow();
      expect(
        (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: second.id } })).status
      ).toBe("error");
      expect((await Effect.runPromise(service.pollConnectionStatuses([second.id]))).connections[0]?.setupPhase).toBe("validation_failed");
      fixture.registerClient("public-client", view.callbackUrl);
      await Effect.runPromise(
        service.configuration.save(second.id, {
          values: { clientId: "public-client" },
          secrets: { clientSecret: { action: "clear" } },
          tokenEndpointAuthMethod: "none",
        })
      );
      await authorize(second.id, "Account B");
      expect(
        JSON.stringify(
          await Effect.runPromise(
            service.testTool(second.id, { toolName: "whoami", arguments: {} })
          )
        )
      ).toContain("Account B");
      await Effect.runPromise(service.authenticate(second.id));
      const pending = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: second.id } });
      const credentials = pending.credentials as {
        oauth: { state: string; stateCreatedAt: number };
      };
      credentials.oauth.stateCreatedAt = Date.now() - 16 * 60_000;
      await prisma.pluginConnection.update({ where: { id: second.id }, data: { credentials } });
      await expect(
        Effect.runPromise(
          service.finishAuthentication(second.id, "expired-code", credentials.oauth.state)
        )
      ).rejects.toThrow("state");
      await authorize(second.id, "Account B");
    } finally {
      await service.close();
      fixture.close();
      if (key) await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } });
      await prisma.$disconnect();
    }
  },
  20_000
);
