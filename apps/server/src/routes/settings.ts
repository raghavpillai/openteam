import { ApiError } from "@openteam/contracts";
import { json } from "../http";
import { type RouteContext, run } from "./context";
import { dispatchRoutes, effectRoute } from "./dispatch";

export async function settingsRoutes(context: RouteContext): Promise<Response | undefined> {
  const { app, request, path } = context;

  if (path === "/api/server-settings/web-search") {
    if (request.method === "GET") return json(await app.webSearchSettings.view());
    if (request.method === "PATCH")
      return json(await app.webSearchSettings.save(await request.json().catch(() => null)));
  }

  if (request.method === "PATCH" && path === "/api/server-settings/inference") {
    return json(await run(app.updateInferenceSettings(await request.json().catch(() => null))));
  }
  const inferenceProviderAuthStartMatch = path.match(
    /^\/api\/inference-providers\/([^/]+)\/auth-sessions$/
  );
  if (request.method === "POST" && inferenceProviderAuthStartMatch?.[1]) {
    const input = (await request.json().catch(() => null)) as { authType?: unknown } | null;
    if (input?.authType !== "api_key" && input?.authType !== "oauth") {
      throw new ApiError(400, "invalid_provider_auth_type", "authType must be api_key or oauth");
    }
    return json(
      await run(
        app.startInferenceProviderAuth(
          decodeURIComponent(inferenceProviderAuthStartMatch[1]),
          input.authType
        )
      ),
      201
    );
  }

  const inferenceAuthResponseMatch = path.match(
    /^\/api\/inference-provider-auth-sessions\/([^/]+)\/respond$/
  );
  if (request.method === "POST" && inferenceAuthResponseMatch?.[1]) {
    const input = (await request.json().catch(() => null)) as {
      promptId?: unknown;
      value?: unknown;
    } | null;
    if (
      typeof input?.promptId !== "string" ||
      typeof input.value !== "string" ||
      input.value.length === 0 ||
      input.value.length > 20_000
    ) {
      throw new ApiError(
        400,
        "invalid_provider_auth_response",
        "promptId and a bounded value are required"
      );
    }
    return json(
      await run(
        app.respondToInferenceProviderAuth(
          decodeURIComponent(inferenceAuthResponseMatch[1]),
          input.promptId,
          input.value
        )
      )
    );
  }

  if (request.method === "PATCH" && path === "/api/settings/sidebar") {
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ApiError(
        400,
        "invalid_sidebar_preferences",
        "Sidebar preferences must be an object"
      );
    }
    return json(await run(app.updateSidebarPreferences(input)));
  }
  if (request.method === "GET" && path === "/api/active-agent") {
    return json({ activeAgentId: await run(app.activeAgent()) });
  }
  if (request.method === "PATCH" && path === "/api/active-agent") {
    const input = (await request.json().catch(() => null)) as {
      activeAgentId?: unknown;
    } | null;
    if (!input || typeof input.activeAgentId !== "string") {
      throw new ApiError(400, "invalid_active_agent", "activeAgentId must be a string");
    }
    return json(await run(app.setActiveAgent(input.activeAgentId)));
  }

  return dispatchRoutes(context, routes);
}

const routes = [
  effectRoute("GET", "/api/settings", ({ app }) => app.rootSettings()),
  effectRoute("GET", "/api/server-settings", ({ app, url }, id) =>
    app.serverSettings(url.searchParams.get("provider") ?? undefined)
  ),
  effectRoute("DELETE", /^\/api\/inference-providers\/([^/]+)$/, ({ app }, id) =>
    app.disconnectInferenceProvider(decodeURIComponent(id))
  ),
  effectRoute("GET", /^\/api\/inference-provider-auth-sessions\/([^/]+)$/, ({ app }, id) =>
    app.inferenceProviderAuthSession(decodeURIComponent(id))
  ),
  effectRoute("DELETE", /^\/api\/inference-provider-auth-sessions\/([^/]+)$/, ({ app }, id) =>
    app.cancelInferenceProviderAuth(decodeURIComponent(id))
  ),
];
