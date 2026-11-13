import { createHash } from "node:crypto";

/** Local, disposable OAuth provider and MCP server used by the plugin integration tests. */
export function createOAuthMcpFixture(port = 0, options: { refreshTokens?: boolean } = {}) {
  const clients = new Map<string, { secret?: string; redirectUris: string[] }>();
  const codes = new Map<string, { account: string; clientId: string; redirectUri: string; challenge: string }>();
  const tokens = new Map<string, string>();
  const refreshTokens = new Map<string, { account: string; clientId: string }>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const observations = { refreshes: 0, calls: 0, authMethods: [] as string[] };
  let extraTool = false, denyTokens = false;
  let beforeToken: (() => Promise<void>) | undefined;
  let refreshFailure: { error: string; error_description?: string; status?: number } | null = null;
  const refreshes = options.refreshTokens !== false;
  const tool = (name: string) => ({
    name, description: `Fixture ${name}`, annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", idleTimeout: 120, port, async fetch(request) {
    const url = new URL(request.url), origin = url.origin;
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"], grant_types_supported: refreshes ? ["authorization_code", "refresh_token"] : ["authorization_code"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      });
    if (url.pathname === "/register" && request.method === "POST") {
      const body = (await request.json()) as { redirect_uris: string[]; token_endpoint_auth_method?: string };
      const clientId = crypto.randomUUID(), secret = body.token_endpoint_auth_method === "none" ? undefined : crypto.randomUUID();
      clients.set(clientId, { redirectUris: body.redirect_uris, secret });
      return Response.json({ ...body, client_id: clientId, ...(secret ? { client_secret: secret } : {}) }, { status: 201 });
    }
    // Tests post the account choice straight to /approve with the /authorize query string.
    if (url.pathname === "/approve" && request.method === "POST") {
      const clientId = url.searchParams.get("client_id") ?? "", redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const client = clients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) return Response.json({ error: "invalid_client" }, { status: 400 });
      const callback = new URL(redirectUri);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      const account = String((await request.formData()).get("account") ?? "Account A");
      if (account === "cancel") callback.searchParams.set("error", "access_denied");
      else {
        const code = crypto.randomUUID();
        codes.set(code, { account, clientId, redirectUri, challenge: url.searchParams.get("code_challenge") ?? "" });
        callback.searchParams.set("code", code);
      }
      return Response.redirect(callback, 302);
    }
    if (url.pathname === "/token" && request.method === "POST") {
      await beforeToken?.();
      const body = new URLSearchParams(await request.text());
      const basic = request.headers.get("authorization")?.replace(/^Basic /, "");
      const basicParts = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
      const clientId = basicParts[0] ?? body.get("client_id") ?? "", secret = basicParts[1] ?? body.get("client_secret");
      const client = clients.get(clientId);
      observations.authMethods.push(basic ? "client_secret_basic" : secret ? "client_secret_post" : "none");
      if (!client || (client.secret && secret !== client.secret)) return Response.json({ error: "invalid_client" }, { status: 401 });
      let account: string;
      if (body.get("grant_type") === "refresh_token") {
        if (!refreshes) return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        if (refreshFailure) { const { status = 400, ...error } = refreshFailure; return Response.json(error, { status }); }
        const previous = refreshTokens.get(body.get("refresh_token") ?? "");
        if (!previous || previous.clientId !== clientId) return Response.json({ error: "invalid_grant" }, { status: 400 });
        account = previous.account;
        observations.refreshes++;
      } else {
        const code = body.get("code") ?? "", authorization = codes.get(code);
        codes.delete(code);
        const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
        if (!authorization || authorization.clientId !== clientId || authorization.redirectUri !== body.get("redirect_uri") || authorization.challenge !== challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        account = authorization.account;
      }
      const access = crypto.randomUUID(), refresh = crypto.randomUUID();
      tokens.set(access, account);
      refreshTokens.set(refresh, { account, clientId });
      denyTokens = false;
      return Response.json({ access_token: access, ...(refreshes ? { refresh_token: refresh } : {}), token_type: "Bearer", expires_in: 3600, scope: "read" });
    }
    if (url.pathname === "/mcp") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
      const account = tokens.get(token);
      if (!account || denyTokens) return new Response("Authorization required", {
        status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
      });
      if (request.method === "GET")
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.add(controller); } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const message = (await request.json()) as { id?: string | number; method: string; params?: { cursor?: string; arguments?: unknown } };
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: unknown = {};
      if (message.method === "initialize")
        result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "OpenTeam OAuth fixture", version: "1.0.0" } };
      else if (message.method === "tools/list")
        result = message.params?.cursor ? { tools: [tool("whoami"), ...(extraTool ? [tool("new_tool")] : [])] } : { tools: [tool("echo")], nextCursor: "second-page" };
      else if (message.method === "tools/call") {
        observations.calls++;
        result = { content: [{ type: "text", text: JSON.stringify({ account, arguments: message.params?.arguments }) }] };
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": `fixture-${token}` } });
    }
    return new Response("Not found", { status: 404 });
  } });
  const encoder = new TextEncoder();
  return {
    server,
    observations,
    endpoint: `${server.url.origin}/mcp`,
    setRefreshFailure: (value: typeof refreshFailure) => { refreshFailure = value; },
    setBeforeToken: (value: typeof beforeToken) => { beforeToken = value; },
    registerClient: (id: string, redirectUri: string, secret?: string) => clients.set(id, { redirectUris: [redirectUri], secret }),
    expireTokens: () => { denyTokens = true; },
    notifyToolsChanged: () => {
      extraTool = true;
      for (const stream of streams) {
        try { stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`)); }
        catch { streams.delete(stream); }
      }
    },
    close: () => {
      for (const stream of streams) try { stream.close(); } catch {}
      server.stop(true);
    },
  };
}
