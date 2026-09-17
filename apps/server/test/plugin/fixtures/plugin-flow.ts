import { ApiError } from "@openteam/contracts";
import { createPrismaClient } from "@openteam/db";
import { createPluginTemplate } from "@openteam/plugin-sdk";
import type { AppService } from "../../../src/app-service";
import { pluginMutationRoutes } from "../../../src/routes/plugin-mutation";
import { pluginQueryRoutes } from "../../../src/routes/plugin-query";
import { PluginService } from "../../../src/services/plugin-service";
import { createOAuthMcpFixture } from "./oauth-mcp";

/** Real plugin routes/DB/MCP, with a synthetic catalog and local OAuth provider. */
export async function createPluginFlowFixture(databaseUrl: string) {
  const db = createPrismaClient(databaseUrl);
  const provider = createOAuthMcpFixture();
  const suffix = crypto.randomUUID();
  const oauth = createPluginTemplate("remote-mcp", `flow-oauth-${suffix}`);
  oauth.name = "Flow OAuth";
  oauth.connections[0]!.endpoint = provider.endpoint;
  oauth.connections[0]!.auth = "oauth";
  oauth.connections[0]!.configuration = {};
  oauth.setupFields = [];
  const configured = structuredClone(oauth);
  configured.key = `flow-configured-${suffix}`;
  configured.name = "Flow Manual Setup";
  configured.setup = {
    kind: "oauth_client",
    connectionKey: configured.connections[0]!.key,
    title: "Connect your account",
    description: "Configure the synthetic OAuth application once.",
    documentationUrl: null,
    requiredScopes: ["read"],
    steps: ["Copy the callback URL to your provider."],
    fields: [
      { key: "clientId", label: "Client ID", required: true, secret: false },
      { key: "clientSecret", label: "Client secret", required: true, secret: true },
    ],
  };
  const skill = createPluginTemplate("skills", `flow-skills-${suffix}`);
  skill.name = "Flow Skills";
  const definitions = [oauth, configured, skill];
  const requests: Array<{ method: string; path: string }> = [];
  let app: AppService;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      };
      if (request.method === "OPTIONS") return new Response(null, { headers });
      const path = url.pathname.replace(/^\/api\/v0\//, "/api/");
      requests.push({ method: request.method, path });
      try {
        const context = {
          app,
          request,
          url,
          path,
          authMode: "disabled" as const,
          authenticatedSessionId: null,
        };
        const response =
          (await pluginMutationRoutes(context)) ??
          (await pluginQueryRoutes(context)) ??
          new Response("Not found", { status: 404 });
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        return response;
      } catch (cause) {
        return Response.json(
          {
            error: {
              code: cause instanceof ApiError ? cause.code : "fixture_error",
              message: cause instanceof Error ? cause.message : "Fixture error",
            },
          },
          { status: cause instanceof ApiError ? cause.status : 500, headers }
        );
      }
    },
  });
  const previousPublicUrl = process.env.OPENTEAM_PUBLIC_URL;
  process.env.OPENTEAM_PUBLIC_URL = server.url.origin;
  const service = new PluginService(db);
  if (previousPublicUrl === undefined) delete process.env.OPENTEAM_PUBLIC_URL;
  else process.env.OPENTEAM_PUBLIC_URL = previousPublicUrl;
  Object.assign(service, {
    catalog: async () => definitions,
    definition: async (key: string) => definitions.find((row) => row.key === key),
  });
  app = {
    plugins: service,
    pluginSettings: service.settings,
    pluginConnectionStatuses: service.pollConnectionStatuses,
    pluginBotAccess: service.botAccess,
    installPlugin: service.install,
    uninstallPlugin: service.uninstall,
    addCustomMcp: service.addCustomMcp,
    connectPlugin: service.connect,
    disconnectPlugin: service.disconnect,
    addPluginAccount: service.addAccount,
    configurePluginConnection: service.configure,
    authenticatePlugin: service.authenticate,
    finishPluginAuthentication: service.finishAuthentication,
    restartPluginConnection: service.restart,
    renamePluginAccount: service.renameAccount,
    removePluginAccount: service.removeAccount,
    setMcpInstructions: service.setInstructions,
    setPluginEnablement: service.setEnablement,
    setPluginGrant: service.setGrant,
    setPluginPolicy: service.setPolicy,
  } as unknown as AppService;
  return {
    db,
    server,
    service,
    provider,
    definitions,
    requests,
    async close() {
      await service.close();
      server.stop(true);
      provider.close();
      await db.pluginInstallation.deleteMany({
        where: { pluginKey: { in: definitions.map((row) => row.key) } },
      });
      await db.$disconnect();
    },
  };
}
