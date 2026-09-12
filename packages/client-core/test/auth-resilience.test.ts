import { describe, expect, test } from "bun:test";
import { authResponseError, createOpenTeamAuthClient } from "../src/auth";

const baseUrl = "https://auth-qa.test";
describe("session revocation", () => {
  test("sign-out uses its explicit token without native cookie credentials", async () => {
    const client = createOpenTeamAuthClient({
      baseUrl,
      fetch: async (url, init) => {
        expect(url).toBe(`${baseUrl}/api/auth/sign-out`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
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
