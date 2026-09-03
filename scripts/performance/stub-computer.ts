const port = Number(process.env.OPENTEAM_COMPUTER_PORT ?? 8790);

const screenStatus = (botId: string) => ({
  botId,
  state: "ready",
  width: 1280,
  height: 800,
  display: 100,
  viewerPort: 6200,
  humanTakeover: false,
  agentInputPaused: false,
  apps: ["chromium", "thunar", "terminal"],
  browserProfileScope: "bot",
  browserSessionScope: "computer",
  browserSessionMechanism: "cookie-broker",
  error: null,
});

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ready",
        agent: { ready: true, authenticated: true },
      });
    }
    if (request.method === "PUT" && url.pathname === "/v1/directories") {
      return Response.json({ ok: true });
    }
    const screenMatch = url.pathname.match(/^\/v1\/screens\/([^/]+)$/);
    if (request.method === "GET" && screenMatch?.[1]) {
      return Response.json(screenStatus(screenMatch[1]));
    }
    if (
      request.method === "POST" &&
      /^\/v1\/screens\/[^/]+\/(takeover|pause|actions)$/.test(url.pathname)
    ) {
      const botId = url.pathname.split("/")[3] ?? "unknown";
      const input = (await request.json().catch(() => ({}))) as {
        active?: boolean;
        paused?: boolean;
      };
      return Response.json({
        ...screenStatus(botId),
        humanTakeover: input.active ?? false,
        agentInputPaused: input.paused ?? false,
      });
    }
    return Response.json({ error: "unsupported audit stub route" }, { status: 404 });
  },
});

console.log(`OpenTeam performance-audit computer stub listening on ${port}`);
