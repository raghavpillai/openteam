import {
  ApiError,
  MarkChannelReadInput,
  RegisterPushDeviceInput,
  type SearchCategory,
  UploadAssetInput,
} from "@openteam/contracts";
import { json, parseBody } from "../http";
import {
  assetUploadByteLimit,
  decodeFileNameHeader,
  isAssetUploadEnvelope,
  requireAssetBody,
} from "../services/asset-service";
import { type RouteContext, run } from "./context";
import { bodyRoute, dispatchRoutes, effectRoute } from "./dispatch";
import { searchCategories } from "./input";

export async function clientRoutes(context: RouteContext): Promise<Response | undefined> {
  const { app, request, url, path, authMode, authenticatedSessionId } = context;

  if (request.method === "GET" && ["/api/snapshot", "/api/bootstrap"].includes(path)) {
    return json(await run(app.clientSnapshot()));
  }
  if (request.method === "POST" && path === "/api/notification-devices") {
    if (authMode === "required" && !authenticatedSessionId) {
      return json(
        { error: { code: "unauthorized", message: "Sign in to OpenTeam to continue" } },
        401
      );
    }
    return json(
      await run(
        app.registerPushDevice(
          await parseBody(request, RegisterPushDeviceInput),
          authMode === "required"
            ? { mode: "required", sessionId: authenticatedSessionId as string }
            : { mode: "disabled" }
        )
      ),
      201
    );
  }

  if (request.method === "GET" && path === "/api/client-snapshot") {
    const startedAt = performance.now();
    const snapshot = await run(app.clientSnapshot());
    return json(snapshot, 200, {
      "server-timing": `snapshot;dur=${(performance.now() - startedAt).toFixed(2)}`,
    });
  }
  if (request.method === "GET" && path === "/api/client-bootstrap") {
    const startedAt = performance.now();
    const bootstrap = await run(app.clientBootstrap());
    return json(bootstrap, 200, {
      "server-timing": `bootstrap;dur=${(performance.now() - startedAt).toFixed(2)}`,
    });
  }

  if (request.method === "POST" && path === "/api/assets") {
    const encodedFileName = request.headers.get("x-file-name");
    const contentType = request.headers.get("content-type") ?? "application/octet-stream";
    if (isAssetUploadEnvelope(contentType, encodedFileName)) {
      return json(await run(app.uploadAsset(await parseBody(request, UploadAssetInput))), 201);
    }
    const fileName = decodeFileNameHeader(encodedFileName);
    const byteLimit = assetUploadByteLimit(contentType, fileName);
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
      throw new ApiError(413, "asset_too_large", `Attachment exceeds ${byteLimit} bytes`);
    }
    const stream = requireAssetBody(request.body);
    return json(
      await run(app.uploadBinaryAsset(stream, contentType, fileName, request.signal)),
      201
    );
  }
  if (request.method === "GET" && path === "/api/search") {
    const startedAt = performance.now();
    const categoryValue = url.searchParams.get("category") ?? "all";
    if (!searchCategories.has(categoryValue as SearchCategory)) {
      throw new ApiError(400, "invalid_search_category", "Unknown search category");
    }
    const results = await run(
      app.search(url.searchParams.get("q") ?? "", categoryValue as SearchCategory)
    );
    return json(results, 200, {
      "server-timing": `search;dur=${(performance.now() - startedAt).toFixed(2)}`,
    });
  }

  return dispatchRoutes(context, routes);
}

const routes = [
  effectRoute("GET", /^\/api\/bots\/([^/]+)\/memories$/, ({ app }, id) =>
    app.listBotMemories(decodeURIComponent(id))
  ),
  effectRoute("DELETE", /^\/api\/bots\/([^/]+)\/memories$/, ({ app }, id) =>
    app.deleteBotMemories(decodeURIComponent(id))
  ),
  effectRoute("DELETE", /^\/api\/bots\/([^/]+)\/memories\/([^/]+)$/, ({ app }, id, memoryId) =>
    app.deleteBotMemories(decodeURIComponent(id), decodeURIComponent(memoryId))
  ),
  effectRoute("DELETE", /^\/api\/notification-devices\/([^/]+)$/, ({ app }, id) =>
    app.unregisterPushDevice(decodeURIComponent(id))
  ),
  bodyRoute(
    "POST",
    /^\/api\/channels\/([^/]+)\/read$/,
    MarkChannelReadInput,
    ({ app }, id, input) => app.markChannelRead(decodeURIComponent(id), input.throughSequence)
  ),
  effectRoute("GET", "/api/client-runtime", ({ app }) => app.clientRuntime()),
  effectRoute("GET", "/api/bots", ({ app, url }, id) =>
    app.listBots(url.searchParams.get("includeHidden") === "1")
  ),
];
