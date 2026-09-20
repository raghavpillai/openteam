import { machineChannelResponse } from "./machine-http";
import { connectorTransferResponse, boundedRequest } from "./connector-transfer-http";
import { automationWebhookBinding, receiveAutomationWebhook } from "./automation-webhooks";
import { AdminBroadcastInput, DynamicToolCallRequest, ShellCompletionInput } from "@openteam/contracts";
import { Effect } from "effect";
import { timingSafeEqual } from "node:crypto";
import { AppService } from "./app-service";
import { assetResponse } from "./asset-http";
import { auth, authPrisma } from "./auth";
import { parseAuthMode } from "./auth-mode";
import { authRequestWithClientIp, loginOriginAllowed } from "./auth-request";
import { corsHeaders, errorResponse, json, parseBody, withCors } from "./http";
import { runOwnerCredentialCommand } from "./owner-credentials";
import { botRoutes } from "./routes/bot";
import { channelRoutes } from "./routes/channel";
import { clientRoutes } from "./routes/client";
import { run, type RouteContext } from "./routes/context";
import { conversationRoutes } from "./routes/conversation";
import { eventRoutes } from "./routes/event";
import { pluginMutationRoutes } from "./routes/plugin-mutation";
import { pluginQueryRoutes } from "./routes/plugin-query";
import { routineRoutes } from "./routes/routine";
import { settingsRoutes } from "./routes/settings";
import { transcriptionRoutes } from "./routes/transcription";
import { parseAutoReviewInput } from "./services/auto-review-service";
import { systemVersion } from "./system-version";
import { ScreenVncProxy, type VncConnection } from "./screen-vnc";

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

const vnc = new ScreenVncProxy({
  endpoint: (botId) => app.screens.vncEndpoint(botId),
  authorized: async ({ botId, sessionId }) => {
    const [bot, session] = await Promise.all([
      app.prisma.bot.findUnique({ where: { id: botId }, select: { status: true } }),
      authMode === "disabled" ? Promise.resolve(true) : sessionId
        ? authPrisma.session.findFirst({ where: { id: sessionId, expiresAt: { gt: new Date() } }, select: { id: true } })
        : Promise.resolve(null),
    ]);
    return bot?.status === "active" && Boolean(session);
  },
});

const authorizedInternal = (request: Request): boolean => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(controlToken);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const server = Bun.serve<VncConnection>({
  hostname: process.env.OPENTEAM_SERVER_HOST ?? "0.0.0.0",
  port,
  idleTimeout: 255,
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  websocket: vnc.websocket,
  async fetch(request, requestServer) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v0(?=\/|$)/, "/api");
    const networkRequest=request;
    const requestIpServer={requestIP:()=>requestServer.requestIP(networkRequest)};
    try {
      if(path==="/api/internal/connector-transfer" && request.method==="POST") {
        if(!authorizedInternal(request))return json({error:{code:"unauthorized",message:"Unauthorized"}},401);
        requestServer.timeout(networkRequest,0);
        return await connectorTransferResponse(request,app.internalTools);
      }
      if (path.startsWith("/api/machines/channel/")) {
        requestServer.timeout(networkRequest, 0);
        return await machineChannelResponse(app.machines, request, path, value => app.autoReview.review(parseAutoReviewInput(value)), value => app.savedLogins.operation(value));
      }
      const machineRelay = path.match(/^\/api\/internal\/machines\/([\da-f-]{36})\/bridge(\/.*)$/i);
      if (machineRelay) {
        if (!authorizedInternal(request)) return json({ error: "Unauthorized" }, 401);
        await app.machines.assertRoutable(machineRelay[1]!);
        requestServer.timeout(networkRequest, 0);
        return await app.machines.relay.forward(machineRelay[1]!, machineRelay[2]!, request);
      }
      request=boundedRequest(request,280*1024*1024);
      const automationHook = path.match(/^\/api\/automation-hooks\/([a-zA-Z0-9_-]{1,100})$/);
      if (automationHook && request.method === "POST") {
        const native=await app.automationWebhooks.receive(automationHook[1]!,request);
        if(native)return native;
        const binding = await automationWebhookBinding(automationHook[1]!);
        if (!binding) return json({ error: "Webhook not found" }, 404);
        return await receiveAutomationWebhook(request, binding, (binding.secretEnv ? process.env[binding.secretEnv] : "") ?? "", (owner, event) => app.routines.dispatchEvent(owner, event));
      }
      const publicTemplate = path.match(/^\/api\/templates\/([a-f0-9-]{36})$/i);
      if (request.method === "GET" && publicTemplate?.[1]) return json(await app.reviewRecipe(publicTemplate[1], true));
      if (request.method === "GET" && path === "/api/auth/config") {
        return json({ mode: authMode });
      }
      if (request.method === "GET" && path === "/api/system/version") {
        return json(release);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        if (!loginOriginAllowed(request, url.origin)) {
          return json(
            { error: { code: "invalid_origin", message: "Origin does not match this server" } },
            403
          );
        }
        const loginRequest = authRequestWithClientIp(
          request,
          requestIpServer,
          proxySecret,
          new URL("/api/auth/sign-in/username", request.url),
          await request.text(),
          { trustPrivateForwarder, fallbackOrigin: url.origin, stripCookies: true }
        );
        return withCors(await auth.handler(loginRequest));
      }
      if (url.pathname === "/api/auth/sign-in/username") {
        return json({ error: { code: "not_found", message: "Not found" } }, 404);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/sign-out") {
        const authRequest = authRequestWithClientIp(
          request,
          requestIpServer,
          proxySecret,
          undefined,
          await request.text(),
          { trustPrivateForwarder }
        );
        const signingOutSession = authMode === "required" ? await auth.api.getSession({ headers: authRequest.headers }) : null;
        // Retire the owner session before releasing its computers. Otherwise a
        // reconnect can mint a fresh device credential while sign-out is pending.
        const response = await auth.handler(authRequest);
        if (response.ok && signingOutSession) {
          vnc.revokeSession(signingOutSession.session.id);
          await run(app.disablePushDevicesForSession(signingOutSession.session.id));
          await app.machines.revokeSession(signingOutSession.session.id);
        }
        return withCors(response);
      }
      if (url.pathname.startsWith("/api/auth/")) {
        return withCors(
          await auth.handler(
            authRequestWithClientIp(request, requestIpServer, proxySecret, undefined, undefined, {
              trustPrivateForwarder,
            })
          )
        );
      }
      if(request.method === "GET" && path === "/api/internal/computer-display") {
        if(!authorizedInternal(request))return json({error:"Unauthorized"},401);
        return json(await app.machines.display());
      }
      if (request.method === "POST" && path === "/api/internal/tools/call") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        requestServer.timeout(networkRequest, 0);
        return json(
          await Effect.runPromise(app.handleDynamicTool(await parseBody(request, DynamicToolCallRequest)), {signal:request.signal})
        );
      }
      if (request.method === "POST" && path === "/api/internal/automation-events") {
        if (!authorizedInternal(request)) return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        const input = await request.json() as { owner?: { kind: "bot" | "group"; id: string }; event?: unknown };
        if (!input.owner || !["bot", "group"].includes(input.owner.kind) || typeof input.owner.id !== "string" || !/^[a-f0-9-]{36}$/i.test(input.owner.id)) return json({ error: { code: "invalid_owner", message: "A valid event owner is required" } }, 400);
        return json({ executions: await app.routines.dispatchEvent(input.owner, input.event) });
      }
      if (request.method === "POST" && path === "/api/internal/shell-completions") {
        if (!authorizedInternal(request)) return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        return json(await app.messaging.completeShell(await parseBody(request, ShellCompletionInput)));
      }
      if (request.method === "POST" && path === "/api/internal/permissions/auto-review") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(await run(app.reviewPermission(parseAutoReviewInput(await request.json()))));
      }
      if (request.method === "POST" && path === "/api/internal/permissions/review-action") {
        if (!authorizedInternal(request)) return json({ error: "Unauthorized" }, 401);
        return await app.reviewPolicy.action(await request.json());
      }
      if (request.method === "POST" && path === "/api/internal/broadcast") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(await run(app.broadcast(await parseBody(request, AdminBroadcastInput))));
      }
      if (path.startsWith("/api/internal/machines")) {
        if (!authorizedInternal(request)) return json({error:{code:"unauthorized",message:"Unauthorized"}},401);
        if(path === "/api/internal/machines" && request.method === "GET")return json(await app.machines.list());
        if(path === "/api/internal/machines/preferred" && request.method === "GET")return json(await app.machines.preferred(url.searchParams.get("botId") ?? "", url.searchParams.get("channelId") ?? undefined));
        if(path === "/api/internal/machines/register" && request.method === "POST")return json(await app.machines.save(await request.json()));
        if(path === "/api/internal/machines/observe" && request.method === "POST")return json(await app.machines.observe(await request.json()));
        return json({error:{code:"not_found",message:"Not found"}},404);
      }
      if (path === "/api/internal/server-settings/web-search/credentials" || path === "/api/internal/server-settings/web-fetch/credentials") {
        if (!authorizedInternal(request))
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        if (request.method !== "GET")
          return json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405);
        return json(await (path.includes("/web-fetch/") ? app.webFetchSettings : app.webSearchSettings).credentials());
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
      if (
        path === "/api/internal/server-settings/transcription" ||
        path === "/api/internal/server-settings/transcription/check" ||
        path === "/api/internal/server-settings/transcription/models"
      ) {
        if (!authorizedInternal(request))
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        const response = await transcriptionRoutes({
          app,
          request,
          url,
          path: path.replace("/internal/", "/"),
          authMode,
          authenticatedSessionId: null,
        });
        if (response) return response;
        return json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405);
      }
      if (request.method === "GET" && (url.pathname === "/health" || path === "/api/health")) {
        const runtime = await run(app.health());
        return json(
          { status: runtime.server, runtime, release },
          runtime.server === "ready" ? 200 : 503
        );
      }
      const publicCallback = request.method === "GET" && path === "/api/plugin-oauth/callback";
      const vncMatch = path.match(/^\/api\/bots\/([\da-f-]{36})\/screen\/vnc$/i);
      if (request.method === "GET" && vncMatch)
        return await vnc.upgrade(networkRequest, requestServer, vncMatch[1]!);
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
      if (request.method === "POST" && vncMatch) {
        const response = json(await vnc.issue(vncMatch[1]!, authenticatedSessionId, request.headers.get("origin")));
        response.headers.set("cache-control", "no-store");
        return response;
      }
      // Attachments follow the account's authentication mode just like messages.
      // Knowing a content hash does not grant access to a private conversation.
      const assetMatch = path.match(/^\/api\/assets\/([a-f0-9]{64})$/i);
      if (["GET", "HEAD"].includes(request.method) && assetMatch?.[1]) {
        return assetResponse(app.assets, app.agentData, request, url, assetMatch[1]);
      }
      const context: RouteContext = { app, request, url, path, authMode, authenticatedSessionId };
      for (const route of [
        clientRoutes,
        pluginQueryRoutes,
        settingsRoutes,
        transcriptionRoutes,
        pluginMutationRoutes,
        botRoutes,
        routineRoutes,
        channelRoutes,
        conversationRoutes,
        eventRoutes,
      ]) {
        const response = await route(context);
        if (response) return response;
      }
      return json({ error: { code: "not_found", message: "Route not found" } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
});

const shutdown = async () => {
  vnc.stop();
  app.machines.relay.close();
  server.stop();
  await Effect.runPromise(app.close());
  process.exit(0);
};

process.once("SIGINT", shutdown);

process.once("SIGTERM", shutdown);

console.log(`OpenTeam server listening on ${server.url}`);
