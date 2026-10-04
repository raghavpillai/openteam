import { pluginManagementRoutes } from "./plugin-management";
import {
  ApiError,
  PLUGIN_CONNECTION_ID_MAX_LENGTH,
  PLUGIN_CONNECTION_STATUS_MAX_IDS,
} from "@openteam/contracts";
import { json } from "../http";
import { type RouteContext, run } from "./context";
import { dispatchRoutes, effectRoute } from "./dispatch";
import { boundedQueryInteger } from "./input";

export async function pluginQueryRoutes(context: RouteContext): Promise<Response | undefined> {
  const managed = await pluginManagementRoutes(context);
  if (managed) return managed;
  const { app, request, url, path } = context;

  if (request.method === "GET" && path === "/api/plugin-connections/status") {
    const requestedConnectionIds = url.searchParams.getAll("id");
    if (requestedConnectionIds.length === 0) {
      throw new ApiError(400, "invalid_query_parameter", "At least one connection id is required");
    }
    if (requestedConnectionIds.length > PLUGIN_CONNECTION_STATUS_MAX_IDS) {
      throw new ApiError(
        400,
        "invalid_query_parameter",
        `At most ${PLUGIN_CONNECTION_STATUS_MAX_IDS} connection ids may be polled`
      );
    }
    const connectionIds = [...new Set(requestedConnectionIds)];
    if (
      connectionIds.some((id) => id.length === 0 || id.length > PLUGIN_CONNECTION_ID_MAX_LENGTH)
    ) {
      throw new ApiError(400, "invalid_query_parameter", "Connection id is invalid");
    }
    return json(await run(app.pluginConnectionStatuses(connectionIds)));
  }
  return dispatchRoutes(context, routes);
}

const routes = [effectRoute("GET", "/api/plugins", ({ app }) => app.pluginSettings())];
