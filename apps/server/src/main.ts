import { timingSafeEqual } from "node:crypto";
import {
  AddCustomMcpInput,
  AdminBroadcastInput,
  ApiError,
  ConfigurePluginConnectionInput,
  ComputerHandoffMutationInput,
  ConnectPluginInput,
  CreateBotInput,
  CreateGroupInput,
  DynamicToolCallRequest,
  InstallPluginInput,
  MarkChannelReadInput,
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
  PLUGIN_CONNECTION_ID_MAX_LENGTH,
  PLUGIN_CONNECTION_STATUS_MAX_IDS,
  ReactToChannelMessageInput,
  RegisterPushDeviceInput,
  RenameChannelInput,
  RenamePluginAccountInput,
  ResolveApprovalInput,
  ScreenActionInput,
  ScreenPauseInput,
  ScreenTakeoverInput,
  type SearchCategory,
  SecretSubmissionInput,
  SendMessageInput,
  SetChannelAvatarInput,
  SetChannelHiddenInput,
  SetChannelMembersInput,
  SetMcpInstructionsInput,
  SetPluginEnablementInput,
  SetPluginGrantInput,
  SetPluginToolPolicyInput,
  UpdateBotInput,
  UpdateChannelProfileInput,
  UploadAssetInput,
  WidgetDismissInput,
  WidgetResponseInput,
} from "@openteam/contracts";
import type { RoutineMutationInput } from "@openteam/messaging";
import { Effect, Either } from "effect";
import { AppService } from "./app-service";
import { assetResponse } from "./asset-http";
import { auth, authPrisma } from "./auth";
import { parseAuthMode } from "./auth-mode";
import { authRequestWithClientIp } from "./auth-request";
import { EVENT_POLL_MAX_WAIT_MS, eventPoll, eventStream } from "./event-stream";
import { corsHeaders, errorResponse, json, parseBody, withCors } from "./http";
import { messageContextExtents } from "./message-context-query";
import { runOwnerCredentialCommand } from "./owner-credentials";
import {
  assetUploadByteLimit,
  decodeFileNameHeader,
  isAssetUploadEnvelope,
  requireAssetBody,
} from "./services/asset-service";
import { parseAutoReviewInput } from "./services/auto-review-service";
import { systemVersion } from "./system-version";

const port = Number(process.env.OPENTEAM_PORT ?? 8787);
const controlToken = process.env.OPENTEAM_CONTROL_TOKEN ?? "local-compose-only-change-me";
const proxySecret = process.env.OPENTEAM_PROXY_SECRET ?? "";
const trustPrivateForwarder = process.env.OPENTEAM_ACCESS_MODE === "proxy";
const authMode = parseAuthMode(process.env.OPENTEAM_AUTH_MODE);
const release = systemVersion();

if (process.argv[2] === "owner-credentials") {
  try {
    await runOwnerCredentialCommand();
  } finally {
    await authPrisma.$disconnect();
  }
  process.exit(0);
}

const app = new AppService(authMode);
await Effect.runPromise(app.boot());

const run = async <A>(effect: Effect.Effect<A, Error>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};
const searchCategories = new Set<SearchCategory>([
  "all",
  "messages",
  "bots",
  "channels",
  "files",
  "links",
  "routines",
]);

const eventCursor = (value: string | null): bigint => {
  if (value === null || value === "") return 0n;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_cursor", "Event cursor is invalid");
  }
  try {
    return BigInt(value);
  } catch {
    throw new ApiError(400, "invalid_cursor", "Event cursor is invalid");
  }
};

const boundedQueryInteger = (
  value: string | null,
  fallback: number,
  maximum: number,
  name: string
): number => {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_query_parameter", `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ApiError(400, "invalid_query_parameter", `${name} is outside the supported range`);
  }
  return parsed;
};

const historyCursor = (value: string | null): bigint | null => {
  if (value === null || value === "") return null;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_history_cursor", "History cursor is invalid");
  }
  const parsed = BigInt(value);
  if (parsed < 1n) {
    throw new ApiError(400, "invalid_history_cursor", "History cursor must be positive");
  }
  return parsed;
};

const authorizedInternal = (request: Request): boolean => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(controlToken);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const routineBody = async (
  request: Request
): Promise<RoutineMutationInput & { clientId: string }> => {
  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "invalid_routine", "Routine input must be an object");
  }
  const input = raw as Record<string, unknown>;
  const optionalString = (field: string): string | undefined => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new ApiError(400, "invalid_routine", `${field} must be a string`);
    }
    return value;
  };
  const optionalBoolean = (field: string): boolean | undefined => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      throw new ApiError(400, "invalid_routine", `${field} must be a boolean`);
    }
    return value;
  };
  const expectedRevision = input.expectedRevision;
  if (
    expectedRevision !== undefined &&
    (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1)
  ) {
    throw new ApiError(400, "invalid_routine", "expectedRevision must be a positive integer");
  }
  const presentation = input.presentation;
  if (
    presentation !== undefined &&
    (!presentation ||
      typeof presentation !== "object" ||
      Array.isArray(presentation) ||
      JSON.stringify(presentation).length > 100_000)
  ) {
    throw new ApiError(400, "invalid_routine", "presentation must be a bounded object");
  }
  return {
    action: "update",
    name: optionalString("name"),
    prompt: optionalString("prompt"),
    schedule: optionalString("schedule"),
    trigger: input.trigger,
    presentation,
    enabled: optionalBoolean("enabled"),
    expectedRevision: expectedRevision === undefined ? undefined : Number(expectedRevision),
    clientId:
      typeof input.clientId === "string" && input.clientId.trim()
        ? input.clientId
        : crypto.randomUUID(),
  };
};

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  idleTimeout: 255,
  maxRequestBodySize: 280 * 1024 * 1024,
  async fetch(request, requestServer) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v0(?=\/|$)/, "/api");
    try {
      if (request.method === "GET" && path === "/api/auth/config") {
        return json({ mode: authMode });
      }
      if (request.method === "GET" && path === "/api/system/version") {
        return json(release);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const loginRequest = authRequestWithClientIp(
          request,
          requestServer,
          proxySecret,
          new URL("/api/auth/sign-in/username", request.url),
          await request.text(),
          { trustPrivateForwarder }
        );
        return withCors(await auth.handler(loginRequest));
      }
      if (url.pathname === "/api/auth/sign-in/username") {
        return json({ error: { code: "not_found", message: "Not found" } }, 404);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/sign-out") {
        const authRequest = authRequestWithClientIp(
          request,
          requestServer,
          proxySecret,
          undefined,
          undefined,
          { trustPrivateForwarder }
        );
        if (authMode === "required") {
          const signingOutSession = await auth.api.getSession({ headers: authRequest.headers });
          if (signingOutSession) {
            await run(app.disablePushDevicesForSession(signingOutSession.session.id));
          }
        }
        return withCors(await auth.handler(authRequest));
      }
      if (url.pathname.startsWith("/api/auth/")) {
        return withCors(
          await auth.handler(
            authRequestWithClientIp(request, requestServer, proxySecret, undefined, undefined, {
              trustPrivateForwarder,
            })
          )
        );
      }
      if (request.method === "POST" && path === "/api/internal/tools/call") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(
          await run(app.handleDynamicTool(await parseBody(request, DynamicToolCallRequest)))
        );
      }
      if (request.method === "POST" && path === "/api/internal/permissions/auto-review") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(await run(app.reviewPermission(parseAutoReviewInput(await request.json()))));
      }
      if (request.method === "POST" && path === "/api/internal/broadcast") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(await run(app.broadcast(await parseBody(request, AdminBroadcastInput))));
      }
      if (request.method === "PATCH" && path === "/api/internal/server-settings/inference") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(await run(app.updateInferenceSettings(await request.json().catch(() => null))));
      }
      if (request.method === "GET" && path === "/api/internal/server-settings") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(await run(app.serverSettings(url.searchParams.get("provider") ?? undefined)));
      }
      if (request.method === "GET" && (url.pathname === "/health" || path === "/api/health")) {
        const runtime = await run(app.health());
        return json(
          { status: runtime.server, runtime, release },
          runtime.server === "ready" ? 200 : 503
        );
      }
      const publicAssetMatch = path.match(/^\/api\/assets\/([a-f0-9]{64})$/i);
      if (["GET", "HEAD"].includes(request.method) && publicAssetMatch?.[1]) {
        return assetResponse(app.assets, app.agentData, request, url, publicAssetMatch[1]);
      }
      const publicCallback = request.method === "GET" && path === "/api/plugin-oauth/callback";
      let authenticatedSessionId: string | null = null;
      if (authMode === "required" && !publicCallback) {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return json(
            { error: { code: "unauthorized", message: "Sign in to OpenTeam to continue" } },
            401
          );
        }
        authenticatedSessionId = session.session.id;
      }
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
      const notificationDeviceMatch = path.match(/^\/api\/notification-devices\/([^/]+)$/);
      if (request.method === "DELETE" && notificationDeviceMatch?.[1]) {
        return json(
          await run(app.unregisterPushDevice(decodeURIComponent(notificationDeviceMatch[1])))
        );
      }
      const channelReadMatch = path.match(/^\/api\/channels\/([^/]+)\/read$/);
      if (request.method === "POST" && channelReadMatch?.[1]) {
        const input = await parseBody(request, MarkChannelReadInput);
        return json(
          await run(
            app.markChannelRead(decodeURIComponent(channelReadMatch[1]), input.throughSequence)
          )
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
      if (request.method === "GET" && path === "/api/client-runtime") {
        return json(await run(app.clientRuntime()));
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
      if (request.method === "GET" && path === "/api/bots") {
        return json(await run(app.listBots(url.searchParams.get("includeHidden") === "1")));
      }
      if (request.method === "GET" && path === "/api/plugins") {
        return json(await run(app.pluginSettings()));
      }
      if (request.method === "GET" && path === "/api/plugin-connections/status") {
        const requestedConnectionIds = url.searchParams.getAll("id");
        if (requestedConnectionIds.length === 0) {
          throw new ApiError(
            400,
            "invalid_query_parameter",
            "At least one connection id is required"
          );
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
      const pluginBotAccessMatch = path.match(/^\/api\/plugins\/([^/]+)\/bot-access$/);
      if (request.method === "GET" && pluginBotAccessMatch?.[1]) {
        const query = url.searchParams.get("q") ?? "";
        if (query.length > PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH) {
          throw new ApiError(
            400,
            "invalid_query_parameter",
            `q cannot exceed ${PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH} characters`
          );
        }
        const offset = boundedQueryInteger(url.searchParams.get("offset"), 0, 100_000, "offset");
        const limit = boundedQueryInteger(
          url.searchParams.get("limit"),
          PLUGIN_BOT_ACCESS_PAGE_SIZE,
          PLUGIN_BOT_ACCESS_PAGE_SIZE,
          "limit"
        );
        if (limit < 1) {
          throw new ApiError(400, "invalid_query_parameter", "limit must be at least 1");
        }
        return json(
          await run(
            app.pluginBotAccess(decodeURIComponent(pluginBotAccessMatch[1]), query, offset, limit)
          )
        );
      }
      if (request.method === "GET" && path === "/api/settings") {
        return json(await run(app.rootSettings()));
      }
      if (request.method === "GET" && path === "/api/server-settings") {
        return json(await run(app.serverSettings(url.searchParams.get("provider") ?? undefined)));
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
          throw new ApiError(
            400,
            "invalid_provider_auth_type",
            "authType must be api_key or oauth"
          );
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
      const inferenceProviderMatch = path.match(/^\/api\/inference-providers\/([^/]+)$/);
      if (request.method === "DELETE" && inferenceProviderMatch?.[1]) {
        return json(
          await run(app.disconnectInferenceProvider(decodeURIComponent(inferenceProviderMatch[1])))
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
      const inferenceAuthSessionMatch = path.match(
        /^\/api\/inference-provider-auth-sessions\/([^/]+)$/
      );
      if (request.method === "GET" && inferenceAuthSessionMatch?.[1]) {
        return json(
          await run(
            app.inferenceProviderAuthSession(decodeURIComponent(inferenceAuthSessionMatch[1]))
          )
        );
      }
      if (request.method === "DELETE" && inferenceAuthSessionMatch?.[1]) {
        return json(
          await run(
            app.cancelInferenceProviderAuth(decodeURIComponent(inferenceAuthSessionMatch[1]))
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
      if (request.method === "POST" && path === "/api/plugins/install") {
        const input = await parseBody(request, InstallPluginInput);
        return json(await run(app.installPlugin(input.pluginKey, input.values)), 201);
      }
      if (request.method === "POST" && path === "/api/plugins/custom-mcp") {
        const input = await parseBody(request, AddCustomMcpInput);
        return json(await run(app.addCustomMcp(input)), 201);
      }
      if (request.method === "GET" && path === "/api/plugin-oauth/callback") {
        const connectionId = url.searchParams.get("connectionId");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          throw new ApiError(
            400,
            "plugin_oauth_denied",
            url.searchParams.get("error_description") ?? oauthError
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
      const pluginMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
      if (request.method === "DELETE" && pluginMatch?.[1]) {
        return json(await run(app.uninstallPlugin(decodeURIComponent(pluginMatch[1]))));
      }
      const pluginEnablementMatch = path.match(/^\/api\/plugins\/([^/]+)\/enablement$/);
      if (request.method === "POST" && pluginEnablementMatch?.[1]) {
        const input = await parseBody(request, SetPluginEnablementInput);
        return json(
          await run(
            app.setPluginEnablement(
              decodeURIComponent(pluginEnablementMatch[1]),
              input.botId,
              input.enabled,
              input.skillsEnabled
            )
          )
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
      const connectionConfigureMatch = path.match(
        /^\/api\/plugin-connections\/([^/]+)\/configure$/
      );
      if (request.method === "POST" && connectionConfigureMatch?.[1]) {
        return json(
          await run(
            app.configurePluginConnection(
              connectionConfigureMatch[1],
              await parseBody(request, ConfigurePluginConnectionInput)
            )
          )
        );
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
      const connectionRestartMatch = path.match(/^\/api\/plugin-connections\/([^/]+)\/restart$/);
      if (request.method === "POST" && connectionRestartMatch?.[1]) {
        return json(await run(app.restartPluginConnection(connectionRestartMatch[1])));
      }
      const connectionInstructionsMatch = path.match(
        /^\/api\/plugin-connections\/([^/]+)\/instructions$/
      );
      if (request.method === "PATCH" && connectionInstructionsMatch?.[1]) {
        const input = await parseBody(request, SetMcpInstructionsInput);
        return json(
          await run(app.setMcpInstructions(connectionInstructionsMatch[1], input.instructions))
        );
      }
      const connectionAccountItemMatch = path.match(
        /^\/api\/plugin-connections\/([^/]+)\/account$/
      );
      if (request.method === "PATCH" && connectionAccountItemMatch?.[1]) {
        const input = await parseBody(request, RenamePluginAccountInput);
        return json(await run(app.renamePluginAccount(connectionAccountItemMatch[1], input.alias)));
      }
      if (request.method === "DELETE" && connectionAccountItemMatch?.[1]) {
        return json(await run(app.removePluginAccount(connectionAccountItemMatch[1])));
      }
      const connectionGrantMatch = path.match(/^\/api\/plugin-connections\/([^/]+)\/grant$/);
      if (request.method === "POST" && connectionGrantMatch?.[1]) {
        const input = await parseBody(request, SetPluginGrantInput);
        return json(
          await run(app.setPluginGrant(connectionGrantMatch[1], input.botId, input.enabled))
        );
      }
      const connectionPolicyMatch = path.match(/^\/api\/plugin-connections\/([^/]+)\/policy$/);
      if (request.method === "POST" && connectionPolicyMatch?.[1]) {
        return json(
          await run(
            app.setPluginPolicy(
              connectionPolicyMatch[1],
              await parseBody(request, SetPluginToolPolicyInput)
            )
          )
        );
      }
      if (request.method === "POST" && path === "/api/bots") {
        return json(await run(app.createBot(await parseBody(request, CreateBotInput))), 201);
      }
      if (request.method === "GET" && path === "/api/channels") {
        const snapshot = await run(app.clientSnapshot());
        return json({
          channels: snapshot.channels,
          messages: snapshot.channelMessages,
          rounds: snapshot.channelRounds,
        });
      }
      if (request.method === "POST" && path === "/api/channels") {
        return json(await run(app.createGroup(await parseBody(request, CreateGroupInput))), 201);
      }
      if (request.method === "GET" && path === "/api/groups") {
        return json(await run(app.listGroups(url.searchParams.get("includeHidden") === "1")));
      }

      const screenMatch = path.match(/^\/api\/bots\/([^/]+)\/screen$/);
      if (request.method === "GET" && screenMatch?.[1]) {
        return json(await run(app.screenStatus(screenMatch[1])));
      }
      const screenFrameMatch = path.match(/^\/api\/bots\/([^/]+)\/screen\/frame$/);
      if (request.method === "GET" && screenFrameMatch?.[1]) {
        const frame = await run(app.screenFrame(screenFrameMatch[1]));
        return new Response(frame.bytes, {
          headers: {
            ...corsHeaders,
            "content-type": frame.contentType,
            "cache-control": "no-store, max-age=0",
          },
        });
      }
      const screenActionMatch = path.match(/^\/api\/bots\/([^/]+)\/screen\/actions$/);
      if (request.method === "POST" && screenActionMatch?.[1]) {
        return json(
          await run(
            app.screenAction(screenActionMatch[1], await parseBody(request, ScreenActionInput))
          )
        );
      }
      const screenTakeoverMatch = path.match(/^\/api\/bots\/([^/]+)\/screen\/takeover$/);
      if (request.method === "POST" && screenTakeoverMatch?.[1]) {
        const input = await parseBody(request, ScreenTakeoverInput);
        return json(await run(app.screenTakeover(screenTakeoverMatch[1], input.active)));
      }
      const screenPauseMatch = path.match(/^\/api\/bots\/([^/]+)\/screen\/pause$/);
      if (request.method === "POST" && screenPauseMatch?.[1]) {
        const input = await parseBody(request, ScreenPauseInput);
        return json(await run(app.screenPause(screenPauseMatch[1], input.paused)));
      }
      const transcriptMatch = path.match(/^\/api\/bots\/([^/]+)\/transcript$/);
      if (request.method === "GET" && transcriptMatch?.[1]) {
        return json(await run(app.botTranscript(transcriptMatch[1])));
      }
      const avatarMatch = path.match(/^\/api\/bots\/([^/]+)\/avatar$/);
      if (request.method === "GET" && avatarMatch?.[1]) {
        const avatar = await run(app.botAvatar(avatarMatch[1]));
        return new Response(avatar.bytes, {
          headers: {
            ...corsHeaders,
            "content-type": avatar.contentType,
            "cache-control": "private, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      }
      const retryProvisioningMatch = path.match(/^\/api\/bots\/([^/]+)\/retry$/);
      if (request.method === "POST" && retryProvisioningMatch?.[1]) {
        return json(await run(app.retryBotProvisioning(retryProvisioningMatch[1])), 202);
      }
      const botRoutinesMatch = path.match(/^\/api\/bots\/([^/]+)\/routines$/);
      if (request.method === "GET" && botRoutinesMatch?.[1]) {
        return json(await run(app.listRoutines(botRoutinesMatch[1])));
      }
      if (request.method === "POST" && botRoutinesMatch?.[1]) {
        const input = await routineBody(request);
        return json(await run(app.createRoutine(botRoutinesMatch[1], input.clientId, input)), 201);
      }
      const groupRoutinesMatch = path.match(/^\/api\/channels\/([^/]+)\/routines$/);
      if (request.method === "GET" && groupRoutinesMatch?.[1]) {
        return json(await run(app.listGroupRoutines(groupRoutinesMatch[1])));
      }
      if (request.method === "POST" && groupRoutinesMatch?.[1]) {
        const input = await routineBody(request);
        return json(
          await run(app.createGroupRoutine(groupRoutinesMatch[1], input.clientId, input)),
          201
        );
      }
      const routineExecutionsMatch = path.match(/^\/api\/routines\/([^/]+)\/executions$/);
      if (request.method === "GET" && routineExecutionsMatch?.[1]) {
        return json(
          await run(
            app.routineExecutions(
              routineExecutionsMatch[1],
              Number(url.searchParams.get("limit") ?? 20)
            )
          )
        );
      }
      const routineActionMatch = path.match(/^\/api\/routines\/([^/]+)\/(pause|resume|test)$/);
      if (request.method === "POST" && routineActionMatch?.[1] && routineActionMatch[2]) {
        const input = await routineBody(request);
        if (routineActionMatch[2] === "test") {
          return json(await run(app.runRoutineNow(routineActionMatch[1], input.clientId)), 202);
        }
        const lifecycleAction = routineActionMatch[2] === "pause" ? "pause" : "resume";
        return json(
          await run(
            app.routineLifecycle(
              routineActionMatch[1],
              input.clientId,
              lifecycleAction,
              input.expectedRevision
            )
          )
        );
      }
      const routineMatch = path.match(/^\/api\/routines\/([^/]+)$/);
      if (request.method === "GET" && routineMatch?.[1]) {
        return json(await run(app.routineDetail(routineMatch[1])));
      }
      if (request.method === "PATCH" && routineMatch?.[1]) {
        const input = await routineBody(request);
        return json(await run(app.updateRoutine(routineMatch[1], input.clientId, input)));
      }
      if (request.method === "DELETE" && routineMatch?.[1]) {
        const input = await routineBody(request);
        return json(
          await run(
            app.routineLifecycle(routineMatch[1], input.clientId, "delete", input.expectedRevision)
          )
        );
      }
      const channelMatch = path.match(/^\/api\/channels\/([^/]+)$/);
      if (request.method === "GET" && channelMatch?.[1]) {
        const snapshot = await run(app.clientSnapshot());
        const channel = snapshot.channels.find((candidate) => candidate.id === channelMatch[1]);
        if (!channel) throw new ApiError(404, "channel_not_found", "Channel not found");
        return json({
          channel,
          messages: snapshot.channelMessages.filter((message) => message.channelId === channel.id),
          rounds: snapshot.channelRounds.filter((round) => round.channelId === channel.id),
          runs: snapshot.runs.filter((candidate) => candidate.channelId === channel.id),
        });
      }
      if (request.method === "DELETE" && channelMatch?.[1]) {
        return json(await run(app.deleteGroup(channelMatch[1])));
      }
      const channelHistoryMatch = path.match(/^\/api\/channels\/([^/]+)\/history$/);
      if (request.method === "GET" && channelHistoryMatch?.[1]) {
        const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
        return json(
          await run(
            app.channelHistory(
              decodeURIComponent(channelHistoryMatch[1]),
              historyCursor(url.searchParams.get("before")),
              requestedLimit
            )
          )
        );
      }
      const channelClientStateMatch = path.match(/^\/api\/channels\/([^/]+)\/client-state$/);
      if (request.method === "GET" && channelClientStateMatch?.[1]) {
        return json(
          await run(app.channelClientState(decodeURIComponent(channelClientStateMatch[1])))
        );
      }
      const channelMessageContextMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/context$/);
      if (request.method === "GET" && channelMessageContextMatch?.[1]) {
        const extents = messageContextExtents(url.searchParams);
        return json(
          await run(
            app.channelMessageContext(
              decodeURIComponent(channelMessageContextMatch[1]),
              extents.before,
              extents.after
            )
          )
        );
      }
      const messageDeliveryMatch = path.match(
        /^\/api\/channels\/([^/]+)\/message-deliveries\/([^/]+)$/
      );
      if (request.method === "GET" && messageDeliveryMatch?.[1] && messageDeliveryMatch[2]) {
        return json(
          await run(
            app.messageDeliveryStatus(
              decodeURIComponent(messageDeliveryMatch[1]),
              decodeURIComponent(messageDeliveryMatch[2])
            )
          )
        );
      }
      const channelMessageMatch = path.match(/^\/api\/channels\/([^/]+)\/messages$/);
      if (request.method === "POST" && channelMessageMatch?.[1]) {
        return json(
          await run(
            app.sendChannelMessage(
              channelMessageMatch[1],
              await parseBody(request, SendMessageInput)
            )
          ),
          202
        );
      }
      const channelRenameMatch = path.match(/^\/api\/channels\/([^/]+)\/name$/);
      if (request.method === "PATCH" && channelRenameMatch?.[1]) {
        return json(
          await run(
            app.renameChannel(channelRenameMatch[1], await parseBody(request, RenameChannelInput))
          )
        );
      }
      const channelProfileMatch = path.match(/^\/api\/channels\/([^/]+)\/profile$/);
      if (request.method === "PATCH" && channelProfileMatch?.[1]) {
        return json(
          await run(
            app.updateChannelProfile(
              channelProfileMatch[1],
              await parseBody(request, UpdateChannelProfileInput)
            )
          )
        );
      }
      const channelAvatarMatch = path.match(/^\/api\/channels\/([^/]+)\/avatar$/);
      if (request.method === "PUT" && channelAvatarMatch?.[1]) {
        return json(
          await run(
            app.setChannelAvatar(
              channelAvatarMatch[1],
              await parseBody(request, SetChannelAvatarInput)
            )
          )
        );
      }
      if (request.method === "GET" && channelAvatarMatch?.[1]) {
        const avatar = await run(app.channelAvatar(channelAvatarMatch[1]));
        return new Response(avatar.bytes, {
          headers: {
            ...corsHeaders,
            "content-type": avatar.contentType,
            "cache-control": "private, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      }
      const channelMembersMatch = path.match(/^\/api\/channels\/([^/]+)\/members$/);
      if (request.method === "PUT" && channelMembersMatch?.[1]) {
        return json(
          await run(
            app.setChannelMembers(
              channelMembersMatch[1],
              await parseBody(request, SetChannelMembersInput)
            )
          )
        );
      }
      const channelHiddenMatch = path.match(/^\/api\/channels\/([^/]+)\/hidden$/);
      if (request.method === "PATCH" && channelHiddenMatch?.[1]) {
        return json(
          await run(
            app.setChannelHidden(
              channelHiddenMatch[1],
              await parseBody(request, SetChannelHiddenInput)
            )
          )
        );
      }
      const channelMessageReactionMatch = path.match(
        /^\/api\/channel-messages\/([^/]+)\/reaction$/
      );
      if (request.method === "POST" && channelMessageReactionMatch?.[1]) {
        return json(
          await run(
            app.reactToMessage(
              channelMessageReactionMatch[1],
              await parseBody(request, ReactToChannelMessageInput)
            )
          ),
          202
        );
      }
      const widgetResponseMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/widget-response$/);
      if (request.method === "POST" && widgetResponseMatch?.[1]) {
        return json(
          await run(
            app.respondToWidget(
              decodeURIComponent(widgetResponseMatch[1]),
              await parseBody(request, WidgetResponseInput)
            )
          ),
          202
        );
      }
      const widgetDismissMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/widget-dismiss$/);
      if (request.method === "POST" && widgetDismissMatch?.[1]) {
        return json(
          await run(
            app.dismissWidget(
              decodeURIComponent(widgetDismissMatch[1]),
              await parseBody(request, WidgetDismissInput)
            )
          )
        );
      }
      const secretSubmissionMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/secret$/);
      if (request.method === "POST" && secretSubmissionMatch?.[1]) {
        return json(
          await run(
            app.submitSecret(
              decodeURIComponent(secretSubmissionMatch[1]),
              await parseBody(request, SecretSubmissionInput)
            )
          ),
          202
        );
      }
      const computerHandoffMatch = path.match(
        /^\/api\/channel-messages\/([^/]+)\/computer-handoff$/
      );
      if (request.method === "POST" && computerHandoffMatch?.[1]) {
        return json(
          await run(
            app.mutateComputerHandoff(
              decodeURIComponent(computerHandoffMatch[1]),
              await parseBody(request, ComputerHandoffMutationInput)
            )
          ),
          202
        );
      }
      const botMatch = path.match(/^\/api\/bots\/([^/]+)$/);
      if (request.method === "PATCH" && botMatch?.[1]) {
        return json(
          await run(app.updateBot(botMatch[1], await parseBody(request, UpdateBotInput)))
        );
      }
      if (request.method === "DELETE" && botMatch?.[1]) {
        return json(await run(app.archiveBot(botMatch[1])));
      }
      const archiveMatch = path.match(/^\/api\/bots\/([^/]+)\/archive$/);
      if (request.method === "POST" && archiveMatch?.[1]) {
        return json(await run(app.archiveBot(archiveMatch[1])));
      }
      const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
      if (request.method === "GET" && conversationMatch?.[1]) {
        const snapshot = await run(app.clientSnapshot());
        const bot = snapshot.bots.find(
          (candidate) => candidate.conversationId === conversationMatch[1]
        );
        if (!bot) throw new ApiError(404, "conversation_not_found", "Conversation not found");
        const runs = snapshot.runs.filter((run) => run.conversationId === conversationMatch[1]);
        const runIds = new Set(runs.map((run) => run.id));
        const channel = snapshot.channels.find(
          (candidate) => candidate.directKey === `bot:${bot.id}`
        );
        const subagents = snapshot.subagents.filter(
          (subagent) => subagent.parentChannelId === channel?.id
        );
        const approvalRunIds = new Set([
          ...runIds,
          ...subagents.flatMap((subagent) =>
            subagent.currentRunId ? [subagent.currentRunId] : []
          ),
        ]);
        return json({
          bot,
          messages: channel
            ? snapshot.channelMessages.filter((message) => message.channelId === channel.id)
            : [],
          runs,
          runItems: snapshot.runItems.filter((item) => runIds.has(item.runId)),
          approvals: snapshot.approvals.filter((approval) => approvalRunIds.has(approval.runId)),
          subagents,
        });
      }
      const messageMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (request.method === "POST" && messageMatch?.[1]) {
        return json(
          await run(app.sendMessage(messageMatch[1], await parseBody(request, SendMessageInput))),
          202
        );
      }
      const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch?.[1]) {
        return json(await run(app.cancelRun(cancelMatch[1])));
      }
      const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/(?:resolve|decision)$/);
      if (request.method === "POST" && approvalMatch?.[1]) {
        const input = await parseBody(request, ResolveApprovalInput);
        return json(await run(app.resolveApproval(approvalMatch[1], input.decision)));
      }
      if (request.method === "GET" && path === "/api/events") {
        const cursor = eventCursor(
          url.searchParams.get("after") ?? request.headers.get("last-event-id")
        );
        const body = eventStream(app, cursor, request.signal);
        return new Response(body, {
          headers: {
            ...corsHeaders,
            "content-type": "text/event-stream",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      }
      if (request.method === "GET" && path === "/api/events/poll") {
        const cursor = eventCursor(
          url.searchParams.get("after") ?? request.headers.get("last-event-id")
        );
        const waitMs = boundedQueryInteger(
          url.searchParams.get("waitMs"),
          EVENT_POLL_MAX_WAIT_MS,
          EVENT_POLL_MAX_WAIT_MS,
          "waitMs"
        );
        return json(await eventPoll(app, cursor, request.signal, waitMs));
      }
      return json({ error: { code: "not_found", message: "Route not found" } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
});

const shutdown = async () => {
  server.stop();
  await Effect.runPromise(app.close());
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`OpenTeam server listening on ${server.url}`);
