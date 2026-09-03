import { describe, expect, test } from "bun:test";
import {
  assessOpenTeamAuthSession,
  authHeadersForUrl,
  createAuthSnapshotStore,
  createOpenTeamAuthClient,
  parseAuthUser,
} from "../src/auth";

describe("shared authentication protocol", () => {
  test("signs in with the canonical request and parses the owner", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTeamAuthClient({
      baseUrl: "https://openteam.test/",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json(
          {
            user: {
              id: "owner-1",
              name: " Owner ",
              email: "owner@openteam.invalid",
              username: " owner ",
              image: null,
            },
          },
          { headers: { "set-auth-token": "session-token" } }
        );
      },
    });

    const result = await client.signIn("  owner  ", "secret");

    const request = requests[0];
    expect(request?.url).toBe("https://openteam.test/api/auth/login");
    expect(request?.init?.method).toBe("POST");
    expect(new Headers(request?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      username: "owner",
      password: "secret",
      rememberMe: true,
    });
    expect(result).toEqual({
      token: "session-token",
      user: {
        id: "owner-1",
        name: "Owner",
        email: "owner@openteam.invalid",
        username: "owner",
        image: null,
      },
    });
  });

  test("fails closed for unknown auth modes and rejects invalid sessions", async () => {
    const responses = [
      Response.json({ mode: "off" }),
      Response.json({ session: { id: "session" }, user: { id: "missing-name" } }),
    ];
    const client = createOpenTeamAuthClient({
      baseUrl: "https://openteam.test",
      fetch: async () => responses.shift() as Response,
    });

    expect(await client.discoverMode()).toBe("required");
    expect(await client.getSession("session-token")).toBeNull();
  });

  test("rejects a reachable website that does not expose the OpenTeam auth protocol", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl: "https://example.test",
      fetch: async () => new Response("Not found", { status: 404 }),
    });

    await expect(client.validateServer()).rejects.toMatchObject({
      code: "invalid_server",
      status: 404,
    });
  });

  test("surfaces the server's nested authentication error", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl: "https://openteam.test",
      fetch: async () =>
        Response.json({ error: { message: "Wrong username or password" } }, { status: 401 }),
    });

    await expect(client.signIn("owner", "wrong")).rejects.toThrow("Wrong username or password");
  });

  test("only attaches a bearer to same-origin API resources", () => {
    expect(authHeadersForUrl("https://openteam.test", "token", "/api/v0/assets/1")).toEqual({
      authorization: "Bearer token",
    });
    expect(
      authHeadersForUrl("https://openteam.test", "token", "https://evil.test/api/v0/assets/1")
    ).toBeUndefined();
    expect(authHeadersForUrl("https://openteam.test", "token", "/public/file")).toBeUndefined();
  });

  test("shares one observable auth snapshot vocabulary across platforms", () => {
    const store = createAuthSnapshotStore({
      status: "checking",
      mode: "required",
      connection: "unknown",
      error: null,
      user: null,
    });
    let changes = 0;
    const unsubscribe = store.subscribe(() => {
      changes += 1;
    });
    store.publish({
      status: "signed-out",
      mode: "required",
      connection: "offline",
      error: null,
      user: null,
    });
    unsubscribe();
    expect(changes).toBe(1);
    expect(store.getSnapshot().connection).toBe("offline");
    expect(parseAuthUser(null)).toBeNull();
  });

  test("shares required-session validation and secure-storage outcomes", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl: "https://openteam.test",
      fetch: async (input) =>
        String(input).endsWith("/api/auth/config")
          ? Response.json({ mode: "required" })
          : Response.json({
              session: { id: "session-1" },
              user: {
                id: "owner-1",
                name: "Owner",
                email: "owner@openteam.invalid",
              },
            }),
    });

    const assessment = await assessOpenTeamAuthSession({
      client,
      loadToken: async () => "session-token",
    });

    expect(assessment).toMatchObject({
      status: "authenticated",
      mode: "required",
      connection: "online",
      observedMode: "required",
      clearCredentials: false,
    });
    expect(assessment.user?.id).toBe("owner-1");
  });

  test("only trusts an explicitly cached disabled mode during offline discovery", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl: "https://openteam.test",
      fetch: async () => {
        throw new Error("offline");
      },
    });
    let tokenReads = 0;
    const assessment = await assessOpenTeamAuthSession({
      client,
      loadCachedMode: async () => "disabled",
      loadToken: async () => {
        tokenReads += 1;
        return "stale-token";
      },
    });

    expect(assessment).toMatchObject({
      status: "authenticated",
      mode: "disabled",
      connection: "offline",
      clearCredentials: true,
    });
    expect(tokenReads).toBe(0);
  });
});
