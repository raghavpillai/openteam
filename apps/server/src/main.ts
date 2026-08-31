import { timingSafeEqual } from "node:crypto";
import {
  AddCustomMcpInput,
  AdminBroadcastInput,
  ApiError,
  ConfigurePluginConnectionInput,
  ConnectPluginInput,
  CreateBotInput,
  CreateGroupInput,
  DynamicToolCallRequest,
  InstallPluginInput,
  MarkChannelReadInput,
  ReactToChannelMessageInput,
  RenameChannelInput,
  RenamePluginAccountInput,
  RegisterPushDeviceInput,
  ResolveApprovalInput,
  ScreenActionInput,
  ScreenPauseInput,
  ScreenTakeoverInput,
  type SearchCategory,
  SendMessageInput,
  SetChannelAvatarInput,
  SetChannelMembersInput,
  SetMcpInstructionsInput,
  SetPluginEnablementInput,
  SetPluginGrantInput,
  SetPluginToolPolicyInput,
  UpdateBotInput,
  UpdateChannelProfileInput,
  UploadAssetInput,
} from "@openbot/contracts";
import type { RoutineMutationInput } from "@openbot/messaging";
import { Effect, Either } from "effect";
import { AppService } from "./app-service";
import { authorizedApi, isTrustedLocalApiClient } from "./api-auth";
import { assetResponse } from "./asset-http";
import { auth, authPrisma } from "./auth";
import { corsHeaders, errorResponse, json, parseBody, withCors } from "./http";
import { runOwnerCredentialCommand } from "./owner-credentials";
import { parseAutoReviewInput } from "./services/auto-review-service";

const port = Number(process.env.OPENBOT_PORT ?? 8787);
const controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
const apiToken = process.env.OPENBOT_API_TOKEN?.trim() || null;
const trustLoopbackApi = process.env.OPENBOT_API_TRUST_LOOPBACK !== "false";

if (process.argv[2] === "owner-credentials") {
  try {
    await runOwnerCredentialCommand();
  } finally {
    await authPrisma.$disconnect();
  }
  process.exit(0);
}
const app = new AppService();
await Effect.runPromise(app.boot());

const run = async <A>(effect: Effect.Effect<A, Error>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};
const encoder = new TextEncoder();
const searchCategories = new Set<SearchCategory>([
  "all",
  "messages",
  "bots",
  "channels",
  "files",
  "links",
  "routines",
]);

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
  async fetch(request) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v0(?=\/|$)/, "/api");
    try {
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const loginRequest = new Request(new URL("/api/auth/sign-in/username", request.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        });
        return withCors(await auth.handler(loginRequest));
      }
      if (url.pathname === "/api/auth/sign-in/username") {
        return json({ error: { code: "not_found", message: "Not found" } }, 404);
      }
      if (url.pathname.startsWith("/api/auth/")) {
        return withCors(await auth.handler(request));
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
      const publicAsset =
        (request.method === "GET" || request.method === "HEAD") &&
        /^\/api\/assets\/[a-f0-9]{64}$/.test(path);
      const publicCallback = request.method === "GET" && path === "/api/plugin-oauth/callback";
      const clientAddress = server.requestIP(request)?.address;
      const trustedLocalClient = isTrustedLocalApiClient(
        clientAddress,
        url.hostname,
        trustLoopbackApi
      );
      if (request.method === "GET" && (url.pathname === "/health" || path === "/api/health")) {
        const runtime = await run(app.health());
        return json({ status: runtime.server, runtime });
      }
      if (!publicAsset && !publicCallback) {
        const session = await auth.api.getSession({ headers: request.headers });
        const apiAuthorized = authorizedApi(request, apiToken, clientAddress, false);
        if (!session && !apiAuthorized) {
          if (!apiToken && !trustedLocalClient) {
            return json(
              {
                error: {
                  code: "api_auth_not_configured",
                  message: "Remote API access requires OPENBOT_API_TOKEN or an owner session",
                },
              },
              503
            );
          }
          return json(
            { error: { code: "unauthorized", message: "Sign in to OpenBot to continue" } },
            401
          );
        }
      }
      if (request.method === "GET" && ["/api/snapshot", "/api/bootstrap"].includes(path)) {
        return json(await run(app.clientSnapshot()));
      }
      if (request.method === "POST" && path === "/api/notification-devices") {
        return json(
          await run(app.registerPushDevice(await parseBody(request, RegisterPushDeviceInput))),
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
      if (request.method === "POST" && path === "/api/assets") {
        return json(await run(app.uploadAsset(await parseBody(request, UploadAssetInput))), 201);
      }
      const assetMatch = path.match(/^\/api\/assets\/([a-f0-9]{64})$/);
      if ((request.method === "GET" || request.method === "HEAD") && assetMatch?.[1]) {
        return await assetResponse(app.assets, app.agentData, request, url, assetMatch[1]);
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
        return json((await run(app.clientSnapshot())).bots);
      }
      if (request.method === "GET" && path === "/api/plugins") {
        return json(await run(app.pluginSettings()));
      }
      if (request.method === "GET" && path === "/api/settings") {
        return json(await run(app.rootSettings()));
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
          "<!doctype html><meta charset=utf-8><title>Connected</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#171717;color:#f5f5f5}main{text-align:center}p{color:#a3a3a3}</style><main><h1>Plugin connected</h1><p>You can close this tab and return to OpenBot.</p><script>setTimeout(()=>window.close(),900)</script></main>",
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
        let cursor = BigInt(
          url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0"
        );
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"));
            while (!request.signal.aborted) {
              try {
                const events = await app.eventsAfter(cursor);
                for (const event of events) {
                  cursor = BigInt(event.sequence);
                  controller.enqueue(
                    encoder.encode(
                      `id: ${event.sequence}\nevent: product\ndata: ${JSON.stringify(event)}\n\n`
                    )
                  );
                }
                if (events.length === 0) controller.enqueue(encoder.encode(": keepalive\n\n"));
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
              } catch (error) {
                controller.enqueue(
                  encoder.encode(
                    `event: stream-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`
                  )
                );
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
              }
            }
            controller.close();
          },
        });
        return new Response(body, {
          headers: {
            ...corsHeaders,
            "content-type": "text/event-stream",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
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

console.log(`OpenBot server listening on ${server.url}`);
