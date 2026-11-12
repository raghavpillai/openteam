import { describe, expect, test } from "bun:test";
import {
  assessOpenTeamAuthSession,
  authHeadersForUrl,
  createOpenTeamAuthClient,
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

  test("only attaches a bearer to same-origin API resources", () => {
    expect(authHeadersForUrl("https://openteam.test", "token", "/api/v0/assets/1")).toEqual({
      authorization: "Bearer token",
    });
    expect(
      authHeadersForUrl("https://openteam.test", "token", "https://evil.test/api/v0/assets/1")
    ).toBeUndefined();
    expect(authHeadersForUrl("https://openteam.test", "token", "/public/file")).toBeUndefined();
  });

  test("keeps the credential when session lookup hits a server or proxy error", async () => {
    for (const status of [500, 502, 503, 504]) {
      const client = createOpenTeamAuthClient({
        baseUrl: "https://openteam.test",
        fetch: async (input) =>
          String(input).endsWith("/api/auth/config")
            ? Response.json({ mode: "required" })
            : new Response("Bad gateway", { status }),
      });

      await expect(client.getSession("session-token")).rejects.toMatchObject({
        code: "offline",
        status,
      });
      const assessment = await assessOpenTeamAuthSession({
        client,
        loadToken: async () => "session-token",
      });
      expect(assessment).toMatchObject({
        status: "authenticated",
        connection: "offline",
        clearCredentials: false,
      });
    }
  });

  test("clears the credential when the server rejects the session", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl: "https://openteam.test",
      fetch: async (input) =>
        String(input).endsWith("/api/auth/config")
          ? Response.json({ mode: "required" })
          : new Response("Unauthorized", { status: 401 }),
    });

    expect(await client.getSession("session-token")).toBeNull();
    expect(
      await assessOpenTeamAuthSession({ client, loadToken: async () => "session-token" })
    ).toMatchObject({ status: "signed-out", clearCredentials: true });
  });

});

const baseUrl = "https://auth-qa.test";
describe("session revocation", () => {
  test("a rejected sign-out cannot silently claim session revocation", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl,
      fetch: async () => new Response(null, { status: 503 }),
    });
    await expect(client.signOut("test-token")).rejects.toMatchObject({
      code: "sign_out_failed",
      status: 503,
    });
  });
});
