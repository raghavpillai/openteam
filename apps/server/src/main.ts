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

const authorizedInternal = (request: Request): boolean => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(controlToken);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const server = Bun.serve({
  hostname: process.env.OPENTEAM_SERVER_HOST ?? "0.0.0.0",
  port,
  idleTimeout: 255,
  maxRequestBodySize: 280 * 1024 * 1024,
  async fetch(request, requestServer) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v0(?=\/|$)/, "/api");
    try {
      const automationHook = path.match(/^\/api\/automation-hooks\/([a-zA-Z0-9_-]{1,100})$/);
      if (automationHook && request.method === "POST") {
        const binding = await automationWebhookBinding(automationHook[1]!);
        if (!binding) return json({ error: "Webhook not found" }, 404);
        return await receiveAutomationWebhook(request, binding, process.env[binding.secretEnv] ?? "", (owner, event) => app.routines.dispatchEvent(owner, event));
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
          requestServer,
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
      if (request.method === "POST" && path === "/api/internal/broadcast") {
        if (!authorizedInternal(request)) {
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        }
        return json(await run(app.broadcast(await parseBody(request, AdminBroadcastInput))));
      }
      if (path === "/api/internal/server-settings/web-search/credentials") {
        if (!authorizedInternal(request))
          return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
        if (request.method !== "GET")
          return json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405);
        return json(await app.webSearchSettings.credentials());
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
  server.stop();
  await Effect.runPromise(app.close());
  process.exit(0);
};

process.once("SIGINT", shutdown);

process.once("SIGTERM", shutdown);

console.log(`OpenTeam server listening on ${server.url}`);
