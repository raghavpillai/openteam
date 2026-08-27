import { timingSafeEqual } from "node:crypto";
import {
  ApiError,
  AddCustomMcpInput,
  ConnectPluginInput,
  CreateBotInput,
  CreateGroupInput,
  DynamicToolCallRequest,
  InstallPluginInput,
  ReactToChannelMessageInput,
  ResolveApprovalInput,
  ScreenActionInput,
  ScreenPauseInput,
  ScreenTakeoverInput,
  SetPluginGrantInput,
  SetPluginEnablementInput,
  SetPluginToolPolicyInput,
  type SearchCategory,
  SendMessageInput,
  UpdateBotInput,
} from "@openbot/contracts";
import { Effect, Either } from "effect";
import { AppService } from "./app-service";
import { corsHeaders, errorResponse, json, parseBody } from "./http";

const port = Number(process.env.OPENBOT_PORT ?? 8787);
const controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
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

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  idleTimeout: 255,
  async fetch(request) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v0(?=\/|$)/, "/api");
    try {
      if (request.method === "POST" && path === "/api/internal/tools/call") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(
          await run(app.handleDynamicTool(await parseBody(request, DynamicToolCallRequest)))
        );
      }
      if (request.method === "GET" && (url.pathname === "/health" || path === "/api/health")) {
        const runtime = await run(app.health());
        return json({ status: runtime.server, runtime });
      }
      if (request.method === "GET" && ["/api/snapshot", "/api/bootstrap"].includes(path)) {
        return json(await run(app.clientSnapshot()));
      }
      if (request.method === "GET" && path === "/api/client-snapshot") {
        const startedAt = performance.now();
        const snapshot = await run(app.clientSnapshot());
        return json(snapshot, 200, {
          "server-timing": `snapshot;dur=${(performance.now() - startedAt).toFixed(2)}`,
        });
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
        return json(await run(app.installPlugin(input.pluginKey)), 201);
      }
      if (request.method === "POST" && path === "/api/plugins/custom-mcp") {
        const input = await parseBody(request, AddCustomMcpInput);
        return json(await run(app.addCustomMcp(input.name, input.url, input.alias)), 201);
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
        return json({
          bot,
          messages: channel
            ? snapshot.channelMessages.filter((message) => message.channelId === channel.id)
            : [],
          runs,
          runItems: snapshot.runItems.filter((item) => runIds.has(item.runId)),
          approvals: snapshot.approvals.filter((approval) => runIds.has(approval.runId)),
        });
      }
      const messageMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (request.method === "POST" && messageMatch?.[1]) {
        return json(
          await run(app.sendMessage(messageMatch[1], await parseBody(request, SendMessageInput))),
          202
        );
      }
      const compactMatch = path.match(/^\/api\/conversations\/([^/]+)\/compact$/);
      if (request.method === "POST" && compactMatch?.[1]) {
        return json(await run(app.compactConversation(compactMatch[1])));
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
