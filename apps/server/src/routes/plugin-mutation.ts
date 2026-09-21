import { pluginManagementRoutes } from "./plugin-management";
import { PluginOAuthStartInput, PluginOAuthCallbackInput, PluginOAuthManualInput } from "@openteam/contracts/plugin-management";
import { pluginOAuthPage } from "./plugin-oauth-page";
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
    let connectionId = url.searchParams.get("connectionId");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    const iss = url.searchParams.get("iss") ?? undefined;
    if (!state || state.length > 4096 || Boolean(code) === Boolean(oauthError) ||
      (code?.length ?? 0) > 8192 || (oauthError?.length ?? 0) > 1000 || (iss?.length ?? 0) > 2000 ||
      ["connectionId", "code", "state", "error", "iss"].some(key => url.searchParams.getAll(key).length > 1)) return pluginOAuthPage("stale", 400);
    try {
      connectionId ??= await run(app.plugins.connectionForOAuthState(state));
      await run(app.plugins.finishServerAuthentication(connectionId, { state, code: code ?? undefined, error: oauthError ?? undefined, iss }));
      return pluginOAuthPage(oauthError ? (oauthError === "access_denied" ? "cancelled" : "failed") : "connected");
    } catch (cause) {
      return pluginOAuthPage(cause instanceof ApiError && ["plugin_oauth_state_invalid", "plugin_oauth_session_changed", "connection_not_found"].includes(cause.code) ? "stale" : "failed", 400);
    }
  }

  const connectionActionMatch = path.match(
    /^\/api\/plugin-connections\/([^/]+)\/(connect|disconnect)$/
  );
  if (request.method === "POST" && connectionActionMatch?.[1]) {
    if (connectionActionMatch[2] === "connect") {
      return json(await run(app.plugins.connect(connectionActionMatch[1], context.authenticatedSessionId)));
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
  const cancelAuthenticationMatch = path.match(/^\/api\/plugin-connections\/([^/]+)\/authenticate\/cancel$/);
  const manualCallbackMatch = path.match(/^\/api\/plugin-connections\/([^/]+)\/authenticate\/manual$/);
  if (request.method === "POST" && manualCallbackMatch?.[1]) {
    // Schema diagnostics can echo rejected values. Never return a pasted authorization code.
    const input = await parseBody(request, PluginOAuthManualInput).catch(() => {
      throw new ApiError(400, "plugin_oauth_callback_invalid", "Paste the complete callback URL from your browser address bar.");
    });
    return json(await run(app.plugins.finishManualAuthentication(manualCallbackMatch[1], input.callbackUrl, context.authenticatedSessionId)));
  }
  const desktopCallbackMatch = path.match(/^\/api\/plugin-connections\/([^/]+)\/authenticate\/callback$/);
  if (request.method === "POST" && desktopCallbackMatch?.[1]) {
    const input = await parseBody(request, PluginOAuthCallbackInput);
    return json(await run(app.plugins.finishDesktopAuthentication(
      desktopCallbackMatch[1], input, context.authenticatedSessionId
    )));
  }
  if (request.method === "POST" && cancelAuthenticationMatch?.[1]) {
    const input = await request.json().catch(() => null) as { state?: unknown; redirectUrl?: unknown } | null;
    if (typeof input?.state !== "string" || !input.state || input.state.length > 4096)
      throw new ApiError(400, "plugin_oauth_state_invalid", "The authorization session is missing. Refresh and try again.");
    return json(await run(app.plugins.cancelClientAuthentication(cancelAuthenticationMatch[1], input.state,
      context.authenticatedSessionId, typeof input.redirectUrl === "string" ? input.redirectUrl : undefined)));
  }
  if (request.method === "POST" && connectionAuthenticateMatch?.[1]) {
    const input = await parseBody(request, PluginOAuthStartInput);
    return json(
      await run(app.plugins.authenticate(connectionAuthenticateMatch[1], input.force === true,
        input.redirectUrl ? { redirectUrl: input.redirectUrl, sessionId: context.authenticatedSessionId } : undefined, context.authenticatedSessionId))
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
