import { ApiError } from "@openteam/contracts";
import { createPrismaClient } from "@openteam/db";
import { createPluginTemplate } from "@openteam/plugin-sdk";
import type { AppService } from "../../../src/app-service";
import { pluginMutationRoutes } from "../../../src/routes/plugin-mutation";
import { pluginQueryRoutes } from "../../../src/routes/plugin-query";
import { PluginService } from "../../../src/services/plugin-service";
import { createOAuthMcpFixture } from "./oauth-mcp";

/** Real plugin routes/DB/MCP, with a synthetic catalog and local OAuth provider. */
export async function createPluginFlowFixture(databaseUrl: string, options: { publicUrl?: string; callbackMode?: "auto" | "server" | "desktop" | "manual"; authSessions?: string[]; packaged?: boolean; refreshTokens?: boolean } = {}) {
  const db = createPrismaClient(databaseUrl);
  const provider = createOAuthMcpFixture(0, {refreshTokens:options.refreshTokens});
  const suffix = crypto.randomUUID();
  const oauth = createPluginTemplate(options.packaged ? "packaged-mcp" : "remote-mcp", `flow-oauth-${suffix}`);
  oauth.name = "Flow OAuth";
  oauth.connections[0]!.endpoint = provider.endpoint;
  oauth.connections[0]!.auth = "oauth";
  oauth.connections[0]!.configuration = { oauthCallbackMode: options.callbackMode ?? "server" };
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
  if (options.packaged) {
    oauth.setup = structuredClone(configured.setup);
    for (const definition of [oauth, configured]) {
      const connector = definition.connections[0]!;
      connector.endpoint = "";
      connector.configuration = { ...connector.configuration, command: "bun", args: ["${PLUGIN_ROOT}/connector/server.mjs"] };
      connector.oauth = {
        clientType: "confidential", registration: "manual", tokenEndpointAuthMethod: "client_secret_post",
        authorizationServer: { issuer: provider.server.url.origin, authorizationUrl: `${provider.server.url.origin}/authorize`, tokenUrl: `${provider.server.url.origin}/token` },
        accessTokenEnv: "PROVIDER_ACCESS_TOKEN",
      };
    }
  }
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
        "access-control-allow-headers": "content-type,authorization",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      };
      if (request.method === "OPTIONS") return new Response(null, { headers });
      const path = url.pathname.replace(/^\/api\/v0\//, "/api/");
      requests.push({ method: request.method, path });
      try {
        // Synthetic login tokens exercise the real routes with distinct session
        // identities. OAuth itself still uses the real local provider and DB.
        const session = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
        const authenticatedSessionId = session && options.authSessions?.includes(session) ? session : null;
        if (options.authSessions && !authenticatedSessionId && path !== "/api/plugin-oauth/callback")
          return Response.json({ error: { code: "unauthorized", message: "Sign in to OpenTeam to continue" } }, { status: 401, headers });
        const context = {
          app,
          request,
          url,
          path,
          authMode: options.authSessions ? "required" as const : "disabled" as const,
          authenticatedSessionId,
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
  const previousAuthMode = process.env.OPENTEAM_AUTH_MODE;
  process.env.OPENTEAM_PUBLIC_URL = options.publicUrl ?? server.url.origin;
  process.env.OPENTEAM_AUTH_MODE = options.authSessions ? "required" : "disabled";
  const runtimes = new Map<string, "ready" | "stopped">();
  const computerRequests: string[] = [];
  const service = new PluginService(db, options.packaged ? async (path, init) => {
    computerRequests.push(`${init?.method ?? "POST"} ${path}`);
    const id = path.split("/")[4]!;
    const runtime = runtimes.get(id) ?? "stopped";
    if (init?.method === "DELETE") { runtimes.set(id, "stopped"); return Response.json({}); }
    if (init?.method === "GET") return Response.json({ state: runtime, tools: runtime === "ready" ? [{ name: "whoami", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] : [] });
    runtimes.set(id, "ready");
    if (path.endsWith("/discover")) return Response.json({ tools: [{ name: "whoami", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
    const body = JSON.parse(String(init?.body));
    const response = await fetch(provider.endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${body.configuration.env.PROVIDER_ACCESS_TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: body.toolName, arguments: body.arguments } }),
    });
    const result = await response.json() as { result: unknown };
    return Response.json({ result: result.result });
  } : undefined);
  if (previousPublicUrl === undefined) delete process.env.OPENTEAM_PUBLIC_URL;
  else process.env.OPENTEAM_PUBLIC_URL = previousPublicUrl;
  if (previousAuthMode === undefined) delete process.env.OPENTEAM_AUTH_MODE;
  else process.env.OPENTEAM_AUTH_MODE = previousAuthMode;
  Object.assign(service, {
    catalog: async () => definitions,
    definition: async (key: string) => definitions.find((row) => row.key === key),
  });
  app = {
    plugins: service,
    pluginSettings: service.settings,
    pluginConnectionStatuses: service.pollConnectionStatuses,
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
  } as unknown as AppService;
  return {
    db,
    server,
    service,
    provider,
    definitions,
    requests,
    computerRequests,
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
