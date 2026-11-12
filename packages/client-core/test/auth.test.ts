import { describe, expect, test } from "bun:test";
import {
  assessOpenTeamAuthSession,
  authResponseError,
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

  test("treats a development proxy upstream failure as an unavailable server", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl: "http://127.0.0.1:5173",
      fetch: async () => new Response("Proxy upstream unavailable", { status: 500 }),
    });

    await expect(client.validateServer()).rejects.toMatchObject({
      code: "offline",
      status: 500,
    });
  });

  test("reports an answer cut off partway as a dropped connection, not a different server", async () => {
    const cutOff = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"mode":"requ'));
            controller.error(new TypeError("network error"));
          },
        })
      );
    const client = createOpenTeamAuthClient({
      baseUrl: "https://openteam.test",
      fetch: async () => cutOff(),
    });

    await expect(client.validateServer()).rejects.toMatchObject({
      code: "offline",
      message: "The connection dropped while checking this server. Try again.",
    });
    // Discovery keeps failing closed instead of throwing.
    expect(await client.discoverMode()).toBe("required");
  });

  test("still rejects a server whose complete answer isn't OpenTeam's", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl: "https://example.test",
      fetch: async () => new Response("<html>Welcome</html>"),
    });

    await expect(client.validateServer()).rejects.toMatchObject({ code: "invalid_server" });
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

  test("accepts username-only accounts without an email or display name", () => {
    expect(parseAuthUser({ id: "owner", username: " raghav " })).toEqual({
      id: "owner",
      username: "raghav",
      name: "raghav",
      email: "",
      image: null,
    });
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

const baseUrl = "https://auth-qa.test";
describe("session revocation", () => {
  test("sign-out uses its explicit token without native cookie credentials", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl,
      fetch: async (url, init) => {
        expect(url).toBe(`${baseUrl}/api/auth/sign-out`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
        expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
        expect(init?.body).toBe("{}");
        // Model the native cookie jar: including login cookies without an Origin
        // produces a CSRF rejection before Better Auth can revoke the session.
        return init?.credentials === "omit"
          ? Response.json({ success: true })
          : Response.json({ code: "MISSING_OR_NULL_ORIGIN" }, { status: 403 });
      },
    });
    await expect(client.signOut("test-token")).resolves.toBeUndefined();
  });
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
describe("bounded authentication requests", () => {
  for (const operation of [
    "validateServer",
    "discoverMode",
    "signIn",
    "getSession",
    "signOut",
  ] as const) {
    test(`${operation} times out and aborts even when fetch ignores cancellation`, async () => {
      let signal: AbortSignal | null | undefined;
      const client = createOpenTeamAuthClient({
        baseUrl,
        timeoutMs: 20,
        fetch: async (_, init) => {
          signal = init?.signal;
          return new Promise<Response>(() => {});
        },
      });
      const request =
        operation === "signIn"
          ? client.signIn("qa", "test-value")
          : operation === "getSession" || operation === "signOut"
            ? client[operation]("test-token")
            : client[operation]();
      await expect(request).rejects.toMatchObject({
        code: "timeout",
        message: "The server took too long to respond. Please try again.",
      });
      expect(signal?.aborted).toBe(true);
    });
  }
  test("bounds an incomplete response body and allows the next attempt to succeed", async () => {
    let stalled = true;
    const client = createOpenTeamAuthClient({
      baseUrl,
      timeoutMs: 20,
      fetch: async () => {
        if (stalled)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"mode":'));
              },
            })
          );
        return Response.json({ mode: "required" });
      },
    });
    await expect(client.validateServer()).rejects.toMatchObject({ code: "timeout" });
    stalled = false;
    await expect(client.validateServer()).resolves.toBe("required");
  });
  test("clears the deadline after a fast response", async () => {
    let signal: AbortSignal | null | undefined;
    const client = createOpenTeamAuthClient({
      baseUrl,
      timeoutMs: 20,
      fetch: async (_, init) => {
        signal = init?.signal;
        return Response.json({ mode: "required" });
      },
    });
    await client.validateServer();
    await Bun.sleep(35);
    expect(signal?.aborted).toBe(false);
  });
  test("ignores a successful login that arrives after its deadline", async () => {
    let finishLate!: (response: Response) => void;
    let settled = "pending";
    const client = createOpenTeamAuthClient({
      baseUrl,
      timeoutMs: 20,
      fetch: async () =>
        new Promise<Response>((resolve) => {
          finishLate = resolve;
        }),
    });
    await client.signIn("qa", "test-value").then(
      () => {
        settled = "authenticated";
      },
      () => {
        settled = "timed-out";
      }
    );
    finishLate(Response.json({}, { headers: { "set-auth-token": "late-test-token" } }));
    await Bun.sleep(0);
    expect(settled).toBe("timed-out");
  });
});
describe("actionable sign-in responses", () => {
  test.each([
    [401, "The username or password is incorrect. Check your details and try again."],
    [403, "This account cannot sign in to this server. Contact your server administrator."],
    [429, "Too many sign-in attempts. Wait a moment and try again."],
    [503, "The server could not complete sign-in. Please try again shortly."],
  ])("explains HTTP %i when a proxy returns no useful message", async (status, expected) => {
    expect(
      await authResponseError(new Response("<html>Proxy error</html>", { status: Number(status) }))
    ).toBe(expected);
  });
  test("preserves a useful account-specific response", async () => {
    expect(
      await authResponseError(
        Response.json(
          { error: { message: "This account is disabled. Contact your administrator." } },
          { status: 403 }
        )
      )
    ).toBe("This account is disabled. Contact your administrator.");
  });
});
