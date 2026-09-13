import { pluginManagementRoutes } from "./plugin-management";
import {
  AddCustomMcpInput,
  ApiError,
  ConfigurePluginConnectionInput,
  ConnectPluginInput,
  InstallPluginInput,
  RenamePluginAccountInput,
  SetMcpInstructionsInput,
  SetPluginEnablementInput,
  SetPluginGrantInput,
  SetPluginToolPolicyInput,
} from "@openteam/contracts";
import { json, parseBody } from "../http";
import { type RouteContext, run } from "./context";
import { bodyRoute, dispatchRoutes, effectRoute } from "./dispatch";

export async function pluginMutationRoutes(context: RouteContext): Promise<Response | undefined> {
  const managed = await pluginManagementRoutes(context);
  if (managed) return managed;
  const { app, request, url, path } = context;

  if (request.method === "GET" && path === "/api/plugin-oauth/callback") {
    const connectionId = url.searchParams.get("connectionId");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      if (connectionId && state) await run(app.plugins.cancelAuthentication(connectionId, state));
      return new Response(
        "<!doctype html><meta charset=utf-8><title>Authorization cancelled</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#171717;color:#f5f5f5}main{text-align:center}p{color:#a3a3a3}</style><main><h1>Authorization cancelled</h1><p>Return to OpenTeam to try again when you are ready.</p></main>",
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    if (!connectionId || !code || !state) {
      throw new ApiError(400, "plugin_oauth_callback_invalid", "OAuth callback is incomplete");
    }
    await run(app.finishPluginAuthentication(connectionId, code, state));
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Connected</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#171717;color:#f5f5f5}main{text-align:center}p{color:#a3a3a3}</style><main><h1>Plugin connected</h1><p>You can close this tab and return to OpenTeam.</p><script>setTimeout(()=>window.close(),900)</script></main>",
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const connectionActionMatch = path.match(
    /^\/api\/plugin-connections\/([^/]+)\/(connect|disconnect)$/
  );
  if (request.method === "POST" && connectionActionMatch?.[1]) {
    if (connectionActionMatch[2] === "connect") {
      return json(await run(app.connectPlugin(connectionActionMatch[1])));
    }
    return json(await run(app.disconnectPlugin(connectionActionMatch[1])));
  }
  const connectionAccountMatch = path.match(/^\/api\/plugin-connections\/([^/]+)\/accounts$/);
  if (request.method === "POST" && connectionAccountMatch?.[1]) {
    const input = await parseBody(request, ConnectPluginInput);
    if (!input.alias) throw new ApiError(400, "connection_alias_required", "Alias is required");
    return json(await run(app.addPluginAccount(connectionAccountMatch[1], input.alias)), 201);
  }

  const connectionAuthenticateMatch = path.match(
    /^\/api\/plugin-connections\/([^/]+)\/authenticate$/
  );
  if (request.method === "POST" && connectionAuthenticateMatch?.[1]) {
    const input = (await request.json().catch(() => ({}))) as { force?: unknown };
    return json(
      await run(app.authenticatePlugin(connectionAuthenticateMatch[1], input.force === true))
    );
  }

  return dispatchRoutes(context, routes);
}

const routes = [
  bodyRoute(
    "POST",
    "/api/plugins/install",
    InstallPluginInput,
    ({ app }, id, input) => app.installPlugin(input.pluginKey, input.values),
    201
  ),
  bodyRoute(
    "POST",
    "/api/plugins/custom-mcp",
    AddCustomMcpInput,
    ({ app }, id, input) => app.addCustomMcp(input),
    201
  ),
  effectRoute("DELETE", /^\/api\/plugins\/([^/]+)$/, ({ app }, id) =>
    app.uninstallPlugin(decodeURIComponent(id))
  ),
  bodyRoute(
    "POST",
    /^\/api\/plugins\/([^/]+)\/enablement$/,
    SetPluginEnablementInput,
    ({ app }, id, input) =>
      app.setPluginEnablement(
        decodeURIComponent(id),
        input.botId,
        input.enabled,
        input.skillsEnabled
      )
  ),
  bodyRoute(
    "POST",
    /^\/api\/plugin-connections\/([^/]+)\/configure$/,
    ConfigurePluginConnectionInput,
    ({ app }, id, input) => app.configurePluginConnection(id, input)
  ),
  effectRoute("POST", /^\/api\/plugin-connections\/([^/]+)\/restart$/, ({ app }, id) =>
    app.restartPluginConnection(id)
  ),
  bodyRoute(
    "PATCH",
    /^\/api\/plugin-connections\/([^/]+)\/instructions$/,
    SetMcpInstructionsInput,
    ({ app }, id, input) => app.setMcpInstructions(id, input.instructions)
  ),
  bodyRoute(
    "PATCH",
    /^\/api\/plugin-connections\/([^/]+)\/account$/,
    RenamePluginAccountInput,
    ({ app }, id, input) => app.renamePluginAccount(id, input.alias)
  ),
  effectRoute("DELETE", /^\/api\/plugin-connections\/([^/]+)\/account$/, ({ app }, id) =>
    app.removePluginAccount(id)
  ),
  bodyRoute(
    "POST",
    /^\/api\/plugin-connections\/([^/]+)\/grant$/,
    SetPluginGrantInput,
    ({ app }, id, input) => app.setPluginGrant(id, input.botId, input.enabled)
  ),
  bodyRoute(
    "POST",
    /^\/api\/plugin-connections\/([^/]+)\/policy$/,
    SetPluginToolPolicyInput,
    ({ app }, id, input) => app.setPluginPolicy(id, input)
  ),
];
