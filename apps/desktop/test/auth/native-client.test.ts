import { describe, expect, test } from "bun:test";
import { desktopSignIn, desktopSignOut } from "../../src/main/auth-client";

describe("desktop native authentication", () => {
  test("signs in and out without a renderer origin or browser cookies", async () => {
    const requests: Request[] = [];
    const bodies: unknown[] = [];
    const user = { id: "owner-1", name: "owner", email: "owner@openteam.invalid" };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(request);
        if (request.headers.has("origin") || request.headers.has("cookie")) {
          return Response.json({ message: "Origin does not match this server" }, { status: 403 });
        }
        if (new URL(request.url).pathname === "/api/auth/login") {
          bodies.push(await request.json());
          return Response.json({ user }, { headers: { "set-auth-token": "signed-test-token" } });
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      const result = await desktopSignIn(server.url.href, " owner ", "test password");
      expect(result.token).toBe("signed-test-token");
      expect(result.user?.id).toBe("owner-1");
      expect(bodies).toEqual([{ username: "owner", password: "test password", rememberMe: true }]);
      await desktopSignOut(server.url.href, result.token);
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/api/auth/login",
        "/api/auth/sign-out",
      ]);
      expect(requests[1]?.headers.get("authorization")).toBe("Bearer signed-test-token");
      expect(requests.every((request) => request.method === "POST")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("does not forward credentials or tokens through redirects", async () => {
    let destinationRequests = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        destinationRequests += 1;
        return Response.json({});
      },
    });
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(destination.url.href, 307),
    });
    try {
      await expect(desktopSignIn(redirector.url.href, "owner", "test password")).rejects.toThrow();
      await expect(desktopSignOut(redirector.url.href, "signed-test-token")).rejects.toThrow();
      expect(destinationRequests).toBe(0);
    } finally {
      redirector.stop(true);
      destination.stop(true);
    }
  });

  test("validates IPC values before sending a request", () => {
    for (const serverUrl of [
      null,
      "file:///etc/passwd",
      "https://user:secret@team.test",
      "https://team.test?redirect=1",
    ]) {
      expect(() => desktopSignIn(serverUrl, "owner", "test password")).toThrow();
    }
    expect(() => desktopSignIn("http://team.test", {}, "test password")).toThrow();
    expect(() => desktopSignIn("http://team.test", "owner", "x".repeat(129))).toThrow();
    expect(() => desktopSignOut("http://team.test", null)).toThrow();
  });
});
