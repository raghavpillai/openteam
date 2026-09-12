// Loopback-only fixture for desktop and iOS onboarding QA. No real accounts or data.
const user = {
  id: "qa-owner",
  name: "QA Owner",
  email: "qa@openteam.invalid",
  username: "qa",
  image: null,
};
const token = "openteam-local-qa-session";
Bun.serve({
  hostname: "127.0.0.1",
  port: 18787,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Expose-Headers": "set-auth-token",
    };
    const json = (value: unknown, status = 200, more = {}) =>
      Response.json(value, { status, headers: { ...headers, ...more } });
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (url.pathname === "/") return new Response("OpenTeam local auth QA fixture", { headers });
    if (url.pathname.includes("/slow/")) await Bun.sleep(20_000);
    else await Bun.sleep(200);
    if (url.pathname.endsWith("/api/auth/config")) {
      if (url.pathname.includes("/wrong-server/"))
        return new Response("<html>Not OpenTeam</html>", { headers });
      if (url.pathname.includes("/unavailable/"))
        return new Response("Maintenance", { status: 503, headers });
      return json({ mode: url.pathname.includes("/no-auth/") ? "disabled" : "required" });
    }
    if (url.pathname.endsWith("/api/auth/login")) {
      if (url.pathname.includes("/limited/"))
        return new Response("Rate limited", { status: 429, headers });
      if (url.pathname.includes("/bad-response/")) return json({ user });
      const input = (await request.json()) as { username?: string; password?: string };
      return input.username === "qa" && input.password === "test-login"
        ? json({ user }, 200, { "set-auth-token": token })
        : new Response(null, { status: 401, headers });
    }
    if (url.pathname.endsWith("/api/auth/get-session"))
      return request.headers.get("authorization") === `Bearer ${token}`
        ? json({ session: { id: "qa-session" }, user })
        : json(null, 401);
    if (url.pathname.endsWith("/api/auth/sign-out"))
      return new Response(null, { status: 204, headers });
    return json({ error: { message: "QA route not found" } }, 404);
  },
});
console.log("Auth QA fixture: http://127.0.0.1:18787 (qa / test-login; synthetic only)");
