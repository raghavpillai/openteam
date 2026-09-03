import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createOpenTeamClient } from "@openteam/client-core";

const secureValues = new Map<string, string>();
const failedDeletes = new Set<string>();
const failedSets = new Set<string>();
let delayedAuthDelete: {
  started: () => void;
  release: Promise<void>;
} | null = null;
let delayedDisabledModeWrite: {
  started: () => void;
  release: Promise<void>;
} | null = null;

mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureValues.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (
      key.startsWith("openteam.auth-mode.v1.") &&
      value.includes('"mode":"disabled"') &&
      delayedDisabledModeWrite
    ) {
      const delayed = delayedDisabledModeWrite;
      delayedDisabledModeWrite = null;
      delayed.started();
      await delayed.release;
    }
    if (failedSets.has(key)) throw new Error("Keychain unavailable");
    secureValues.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    if (failedDeletes.has(key)) throw new Error("Keychain unavailable");
    if (key === "openteam.auth-token" && delayedAuthDelete) {
      const delayed = delayedAuthDelete;
      delayedAuthDelete = null;
      delayed.started();
      await delayed.release;
    }
    secureValues.delete(key);
  },
}));

const {
  authenticateConnection,
  authenticatedUserForServer,
  authHeadersForUrl,
  configureAuthServer,
  getAuthAccountIdForServer,
  getAuthToken,
  getAuthTokenForServer,
  hasValidSession,
  onBeforeSignOut,
  requireAuthenticationForServer,
  signIn,
  signOut,
  testServerConnection,
} = await import("../src/auth");
const { loadServerConnection, saveServerConnection } = await import("../src/server-config");
const originalFetch = globalThis.fetch;

const delay = () => {
  let markStarted = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { markStarted, pending, release, started };
};

beforeEach(() => {
  secureValues.clear();
  failedDeletes.clear();
  failedSets.clear();
  delayedAuthDelete = null;
  delayedDisabledModeWrite = null;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("mobile connection storage", () => {
  test("discards the legacy API token without making connection loading fragile", async () => {
    secureValues.set("openteam.server-url.v1", "https://openteam.test");
    secureValues.set("openteam.api-access-token.v1", "legacy-token");

    await expect(loadServerConnection()).resolves.toEqual({
      serverUrl: "https://openteam.test",
    });
    expect(secureValues.has("openteam.api-access-token.v1")).toBe(false);

    secureValues.set("openteam.api-access-token.v1", "legacy-token");
    failedDeletes.add("openteam.api-access-token.v1");
    await expect(loadServerConnection()).resolves.toEqual({
      serverUrl: "https://openteam.test",
    });
  });

  test("persists the normalized self-hosted endpoint selected at login", async () => {
    await expect(
      saveServerConnection({ serverUrl: " https://bots.example.test/openteam/ " })
    ).resolves.toEqual({ serverUrl: "https://bots.example.test/openteam" });

    expect(secureValues.get("openteam.server-url.v1")).toBe("https://bots.example.test/openteam");
    await expect(loadServerConnection()).resolves.toEqual({
      serverUrl: "https://bots.example.test/openteam",
    });
  });
});

describe("mobile authentication discovery", () => {
  test("never validates a persisted bearer against a different saved server", async () => {
    secureValues.set("openteam.auth-token", "first-origin-session");
    secureValues.set("openteam.auth-token-server", "https://first.openteam.test");
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json({ mode: "required" });
    }) as typeof fetch;

    await expect(hasValidSession("https://second.openteam.test")).resolves.toBe(false);

    expect(calls).toEqual(["https://second.openteam.test/api/auth/config"]);
    expect(getAuthToken()).toBeNull();
    expect(secureValues.has("openteam.auth-token")).toBe(false);
    expect(secureValues.has("openteam.auth-token-server")).toBe(false);
  });

  test("discards an unbound legacy bearer instead of attaching it to a configured origin", async () => {
    secureValues.set("openteam.auth-token", "unbound-legacy-session");
    const calls: Array<{ authorization: string | null; url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        url: String(url),
      });
      return Response.json({ mode: "required" });
    }) as typeof fetch;

    await expect(hasValidSession("https://legacy-safety.openteam.test")).resolves.toBe(false);
    expect(calls).toEqual([
      { authorization: null, url: "https://legacy-safety.openteam.test/api/auth/config" },
    ]);
    expect(secureValues.has("openteam.auth-token")).toBe(false);
  });

  test("bypasses login only when the server explicitly disables authentication", async () => {
    secureValues.set("openteam.auth-token", "old-session");
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json({ mode: "disabled" });
    }) as typeof fetch;

    await expect(hasValidSession("https://openteam.test/")).resolves.toBe(true);
    expect(calls).toEqual(["https://openteam.test/api/auth/config"]);
    expect(secureValues.has("openteam.auth-token")).toBe(false);
    expect(authHeadersForUrl("https://openteam.test/api/v0/assets/image-1")).toBeUndefined();
  });

  test("connects to an explicitly disabled server without fake credentials", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json({ mode: "disabled" });
    }) as typeof fetch;

    await expect(
      authenticateConnection("https://disabled-connect.openteam.test", "", "")
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["https://disabled-connect.openteam.test/api/auth/config"]);
    expect(getAuthToken()).toBeNull();
  });

  test("still requires complete credentials when the server requires authentication", async () => {
    globalThis.fetch = (async () => Response.json({ mode: "required" })) as typeof fetch;

    await expect(
      authenticateConnection("https://required-connect.openteam.test", "", "")
    ).rejects.toThrow("requires a username and password");
  });

  test("tests the endpoint before reporting whether credentials are required", async () => {
    globalThis.fetch = (async (url: string | URL | Request) =>
      Response.json({
        mode: String(url).includes("public") ? "disabled" : "required",
      })) as typeof fetch;

    await expect(testServerConnection("https://public-connect.openteam.test")).resolves.toBe(
      "authenticated"
    );
    await expect(testServerConnection("https://private-connect.openteam.test")).resolves.toBe(
      "credentials-required"
    );
  });

  test("rejects a reachable website that is not an OpenTeam server", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    await expect(testServerConnection("https://google.example.test")).rejects.toThrow(
      "not a compatible OpenTeam server"
    );
    expect(calls).toEqual(["https://google.example.test/api/auth/config"]);
  });

  test("explicit connection tests do not accept an offline cached public mode", async () => {
    const serverUrl = "https://strict-connect.openteam.test";
    globalThis.fetch = (async () => Response.json({ mode: "disabled" })) as typeof fetch;
    await expect(hasValidSession(serverUrl)).resolves.toBe(true);

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(testServerConnection(serverUrl)).rejects.toThrow(
      "Could not reach this OpenTeam server. Check the endpoint and your connection."
    );
  });

  test("distinguishes an unreachable endpoint from a server that requires credentials", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed: native transport details");
    }) as typeof fetch;

    await expect(
      authenticateConnection("https://unreachable.openteam.test", "", "")
    ).rejects.toThrow(
      "Could not reach this OpenTeam server. Check the endpoint and your connection."
    );
    await expect(
      authenticateConnection("https://unreachable-with-login.openteam.test", "owner", "password")
    ).rejects.toThrow(
      "Could not reach this OpenTeam server. Check the endpoint and your connection."
    );
  });

  test("requires a session when discovery says authentication is required", async () => {
    globalThis.fetch = (async () => Response.json({ mode: "required" })) as typeof fetch;

    await expect(hasValidSession("https://openteam.test")).resolves.toBe(false);
  });

  test("does not treat an unknown discovery response as authentication disabled", async () => {
    globalThis.fetch = (async () => Response.json({ mode: "off" })) as typeof fetch;

    await expect(hasValidSession("https://openteam.test")).resolves.toBe(false);
  });

  test("uses a per-origin disabled-mode cache only when discovery is offline", async () => {
    globalThis.fetch = (async () => Response.json({ mode: "disabled" })) as typeof fetch;
    await expect(hasValidSession("https://disabled.openteam.test/path")).resolves.toBe(true);

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(hasValidSession("https://disabled.openteam.test/another-path")).resolves.toBe(
      true
    );
    await expect(hasValidSession("https://other.openteam.test")).resolves.toBe(false);

    globalThis.fetch = (async () => Response.json({ mode: "unknown" })) as typeof fetch;
    await expect(hasValidSession("https://disabled.openteam.test")).resolves.toBe(false);

    globalThis.fetch = (async () => {
      throw new Error("offline again");
    }) as typeof fetch;
    await expect(hasValidSession("https://disabled.openteam.test")).resolves.toBe(false);
  });

  test("serializes same-origin auth-mode writes so an older disabled response cannot win", async () => {
    const disabledWrite = delay();
    delayedDisabledModeWrite = {
      release: disabledWrite.pending,
      started: disabledWrite.markStarted,
    };
    let discoveryCalls = 0;
    globalThis.fetch = (async () => {
      discoveryCalls += 1;
      return Response.json({ mode: discoveryCalls === 1 ? "disabled" : "required" });
    }) as typeof fetch;

    const olderCheck = hasValidSession("https://mode-race.openteam.test");
    await disabledWrite.started;
    const newerCheck = hasValidSession("https://mode-race.openteam.test");
    disabledWrite.release();

    await expect(olderCheck).resolves.toBe(false);
    await expect(newerCheck).resolves.toBe(false);

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(hasValidSession("https://mode-race.openteam.test")).resolves.toBe(false);
  });

  test("removes a cached disabled grant before persisting a required-mode tombstone", async () => {
    const serverUrl = "https://mode-revocation.openteam.test";
    globalThis.fetch = (async () => Response.json({ mode: "disabled" })) as typeof fetch;
    await expect(hasValidSession(serverUrl)).resolves.toBe(true);
    const modeKey = [...secureValues.keys()].find((key) =>
      key.startsWith("openteam.auth-mode.v1.")
    );
    expect(modeKey).toBeDefined();
    if (!modeKey) throw new Error("auth mode cache key was not written");
    failedSets.add(modeKey);

    globalThis.fetch = (async () => Response.json({ mode: "required" })) as typeof fetch;
    await expect(hasValidSession(serverUrl)).rejects.toThrow("Keychain unavailable");
    expect(secureValues.has(modeKey)).toBe(false);

    failedSets.clear();
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(hasValidSession(serverUrl)).resolves.toBe(false);
  });

  test("validates stored password sessions when authentication is required", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      calls.push({
        url: requestUrl,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (requestUrl.endsWith("/api/auth/login")) {
        return Response.json({}, { headers: { "set-auth-token": "signed-session" } });
      }
      return requestUrl.endsWith("/api/auth/config")
        ? Response.json({ mode: "required" })
        : Response.json({
            session: { id: "session-1" },
            user: { id: "owner-1", name: "Owner" },
          });
    }) as typeof fetch;

    await signIn("https://openteam.test", "owner", "password");
    await expect(hasValidSession("https://openteam.test")).resolves.toBe(true);
    expect(getAuthAccountIdForServer("https://openteam.test")).toBe("owner-1");
    expect(secureValues.get("openteam.auth-token-account")).toBe("owner-1");
    expect(calls).toEqual([
      { url: "https://openteam.test/api/auth/login", authorization: null },
      { url: "https://openteam.test/api/auth/config", authorization: null },
      {
        url: "https://openteam.test/api/auth/get-session",
        authorization: "Bearer signed-session",
      },
    ]);
  });

  test("loads the signed-in profile only from its configured server", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      calls.push(requestUrl);
      if (requestUrl.endsWith("/api/auth/login")) {
        return Response.json({}, { headers: { "set-auth-token": "profile-session" } });
      }
      return Response.json({
        session: { id: "profile-session-id" },
        user: { id: "owner-profile", name: "OpenTeam Owner", email: "owner@example.test" },
      });
    }) as typeof fetch;

    await signIn("https://profile.openteam.test", "owner", "password");
    await expect(authenticatedUserForServer("https://profile.openteam.test/")).resolves.toEqual({
      id: "owner-profile",
      name: "OpenTeam Owner",
      email: "owner@example.test",
      username: null,
      image: null,
    });
    const configuredCalls = calls.length;
    await expect(authenticatedUserForServer("https://other.openteam.test")).resolves.toBeNull();
    expect(calls).toHaveLength(configuredCalls);
  });

  test("does not reuse a session after changing server URLs", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/auth/login")) {
        return Response.json({}, { headers: { "set-auth-token": "first-server-session" } });
      }
      return Response.json({ mode: "required" });
    }) as typeof fetch;

    await signIn("https://first.openteam.test", "owner", "password");
    expect(getAuthToken()).toBe("first-server-session");

    configureAuthServer("https://second.openteam.test");
    expect(getAuthToken()).toBeNull();
    expect(authHeadersForUrl("https://second.openteam.test/api/v0/assets/image-1")).toBeUndefined();

    await expect(hasValidSession("https://second.openteam.test")).resolves.toBe(false);
  });

  test("serializes a server switch with a new sign-in so the old delete cannot erase it", async () => {
    let secondLoginStarted = () => undefined;
    const secondLogin = new Promise<void>((resolve) => {
      secondLoginStarted = resolve;
    });
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.includes("second.openteam.test/api/auth/login")) {
        secondLoginStarted();
        return Response.json({}, { headers: { "set-auth-token": "second-server-session" } });
      }
      return Response.json({}, { headers: { "set-auth-token": "first-server-session" } });
    }) as typeof fetch;
    await signIn("https://first.openteam.test", "owner", "password");

    let deleteStarted = () => undefined;
    const started = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    let releaseDelete = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    delayedAuthDelete = { started: deleteStarted, release };

    configureAuthServer("https://second.openteam.test");
    await started;
    const signingIn = signIn("https://second.openteam.test", "owner", "password");
    await secondLogin;
    await Promise.resolve();
    releaseDelete();
    await signingIn;

    expect(getAuthToken()).toBe("second-server-session");
    expect(secureValues.get("openteam.auth-token")).toBe("second-server-session");
    expect(secureValues.get("openteam.auth-token-server")).toBe("https://second.openteam.test");
  });

  test("rejects a delayed old-server login without replacing the new server session", async () => {
    const oldLogin = delay();
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.includes("first.openteam.test/api/auth/login")) {
        oldLogin.markStarted();
        await oldLogin.pending;
        return Response.json({}, { headers: { "set-auth-token": "late-first-session" } });
      }
      return Response.json({}, { headers: { "set-auth-token": "current-second-session" } });
    }) as typeof fetch;

    const delayedFirst = signIn("https://first.openteam.test", "owner", "password");
    await oldLogin.started;
    await signIn("https://second.openteam.test", "owner", "password");
    oldLogin.release();

    await expect(delayedFirst).rejects.toThrow("server changed");
    expect(getAuthToken()).toBe("current-second-session");
    expect(secureValues.get("openteam.auth-token")).toBe("current-second-session");
    expect(secureValues.get("openteam.auth-token-server")).toBe("https://second.openteam.test");
  });

  test("never sends a new server bearer through a delayed old-server session check", async () => {
    const oldDiscovery = delay();
    const sessionRequests: Array<{ authorization: string | null; url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/api/auth/login")) {
        return Response.json(
          {},
          {
            headers: {
              "set-auth-token": requestUrl.includes("first.openteam.test")
                ? "first-session"
                : "second-session",
            },
          }
        );
      }
      if (requestUrl === "https://first.openteam.test/api/auth/config") {
        oldDiscovery.markStarted();
        await oldDiscovery.pending;
        return Response.json({ mode: "required" });
      }
      if (requestUrl.includes("/api/auth/get-session")) {
        sessionRequests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          url: requestUrl,
        });
        return Response.json({ session: { id: "session" }, user: { id: "owner", name: "Owner" } });
      }
      return Response.json({ mode: "required" });
    }) as typeof fetch;

    await signIn("https://first.openteam.test", "owner", "password");
    const staleCheck = hasValidSession("https://first.openteam.test");
    await oldDiscovery.started;
    await signIn("https://second.openteam.test", "owner", "password");
    oldDiscovery.release();

    await expect(staleCheck).resolves.toBe(false);
    expect(sessionRequests).toEqual([]);
    expect(getAuthToken()).toBe("second-session");
  });

  test("does not let a delayed old-token 401 clear a replacement session", async () => {
    const firstUnauthorized = delay();
    const secondUnauthorized = delay();
    let loginCount = 0;
    let sessionCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/auth/login")) {
        loginCount += 1;
        return Response.json(
          {},
          { headers: { "set-auth-token": loginCount === 1 ? "old-session" : "new-session" } }
        );
      }
      if (requestUrl.endsWith("/api/v0/client-snapshot")) {
        sessionCount += 1;
        const pending = sessionCount === 1 ? firstUnauthorized : secondUnauthorized;
        pending.markStarted();
        await pending.pending;
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      }
      return Response.json({});
    }) as typeof fetch;

    const serverUrl = "https://same-origin-401.openteam.test";
    await signIn(serverUrl, "owner", "password");
    const client = createOpenTeamClient({
      baseUrl: serverUrl,
      getAuthToken: () => getAuthTokenForServer(serverUrl),
      onUnauthorized: (usedToken) => requireAuthenticationForServer(serverUrl, usedToken),
    });
    const firstRequest = client.snapshot();
    const secondRequest = client.snapshot();
    await Promise.all([firstUnauthorized.started, secondUnauthorized.started]);

    firstUnauthorized.release();
    await expect(firstRequest).rejects.toMatchObject({ status: 401 });
    await signIn(serverUrl, "owner", "password");
    expect(getAuthToken()).toBe("new-session");

    secondUnauthorized.release();
    await expect(secondRequest).rejects.toMatchObject({ status: 401 });
    expect(getAuthToken()).toBe("new-session");
    expect(secureValues.get("openteam.auth-token")).toBe("new-session");
  });

  test("clears a malformed live session instead of reusing it during a later outage", async () => {
    const serverUrl = "https://malformed-session.openteam.test";
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/auth/login")) {
        return Response.json({}, { headers: { "set-auth-token": "malformed-session" } });
      }
      if (requestUrl.endsWith("/api/auth/config")) {
        return Response.json({ mode: "required" });
      }
      return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await signIn(serverUrl, "owner", "password");
    await expect(hasValidSession(serverUrl)).resolves.toBe(false);
    expect(getAuthToken()).toBeNull();
    expect(secureValues.has("openteam.auth-token")).toBe(false);
  });

  test("does not let a delayed sign-out clear a newer same-server sign-in", async () => {
    const delayedSignOut = delay();
    let loginCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/auth/login")) {
        loginCount += 1;
        return Response.json(
          {},
          { headers: { "set-auth-token": loginCount === 1 ? "old-session" : "new-session" } }
        );
      }
      if (requestUrl.endsWith("/api/auth/sign-out")) {
        delayedSignOut.markStarted();
        await delayedSignOut.pending;
      }
      return Response.json({});
    }) as typeof fetch;

    const serverUrl = "https://same-origin-sign-out.openteam.test";
    await signIn(serverUrl, "owner", "password");
    const retiring = signOut();
    await delayedSignOut.started;
    await signIn(serverUrl, "owner", "password");
    delayedSignOut.release();
    await retiring;

    expect(getAuthToken()).toBe("new-session");
    expect(secureValues.get("openteam.auth-token")).toBe("new-session");
    expect(secureValues.get("openteam.auth-token-server")).toBe(serverUrl);
  });

  test("runs sign-out cleanup while the current server token is still available", async () => {
    globalThis.fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("/api/auth/login")
        ? Response.json({}, { headers: { "set-auth-token": "cleanup-session" } })
        : Response.json({})) as typeof fetch;
    await signIn("https://cleanup.openteam.test", "owner", "password");
    const observedTokens: Array<string | null> = [];
    const unsubscribe = onBeforeSignOut(() => {
      observedTokens.push(getAuthToken());
    });

    await signOut();
    unsubscribe();

    expect(observedTokens).toEqual(["cleanup-session"]);
    expect(getAuthToken()).toBeNull();
  });

  test("never lends a new server token to delayed old-server push requests", async () => {
    const requests: Array<{ authorization: string | null; method: string; url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/auth/login")) {
        return Response.json(
          {},
          {
            headers: {
              "set-auth-token": requestUrl.includes("first.openteam.test")
                ? "first-server-session"
                : "second-server-session",
            },
          }
        );
      }
      if (requestUrl.includes("/api/v0/notification-devices")) {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
          url: requestUrl,
        });
        return requestUrl.includes("first.openteam.test")
          ? Response.json({ error: { code: "unauthorized" } }, { status: 401 })
          : Response.json({});
      }
      return Response.json({});
    }) as typeof fetch;

    await signIn("https://first.openteam.test", "owner", "password");
    const firstClient = createOpenTeamClient({
      baseUrl: "https://first.openteam.test",
      getAuthToken: () => getAuthTokenForServer("https://first.openteam.test"),
      onUnauthorized: (usedToken) =>
        requireAuthenticationForServer("https://first.openteam.test", usedToken),
    });
    let releaseOldPush = () => undefined;
    const oldPushGate = new Promise<void>((resolve) => {
      releaseOldPush = resolve;
    });
    const delayedRegister = oldPushGate.then(() =>
      firstClient.registerPushDevice({
        installationId: "installation-first",
        platform: "ios",
        pushToken: "ExpoPushToken[first-device-token]",
      })
    );
    const delayedUnregister = oldPushGate.then(() =>
      firstClient.unregisterPushDevice("installation-first")
    );

    await signIn("https://second.openteam.test", "owner", "password");
    expect(getAuthTokenForServer("https://first.openteam.test")).toBeNull();
    expect(getAuthTokenForServer("https://second.openteam.test")).toBe("second-server-session");
    releaseOldPush();
    await Promise.allSettled([delayedRegister, delayedUnregister]);

    expect(getAuthToken()).toBe("second-server-session");
    expect(requests.filter(({ url }) => url.includes("first.openteam.test"))).toEqual([
      {
        authorization: null,
        method: "POST",
        url: "https://first.openteam.test/api/v0/notification-devices",
      },
      {
        authorization: null,
        method: "DELETE",
        url: "https://first.openteam.test/api/v0/notification-devices/installation-first",
      },
    ]);

    const secondClient = createOpenTeamClient({
      baseUrl: "https://second.openteam.test",
      getAuthToken: () => getAuthTokenForServer("https://second.openteam.test"),
      onUnauthorized: (usedToken) =>
        requireAuthenticationForServer("https://second.openteam.test", usedToken),
    });
    let releaseSignedOutPush = () => undefined;
    const signedOutPushGate = new Promise<void>((resolve) => {
      releaseSignedOutPush = resolve;
    });
    const delayedAfterSignOut = signedOutPushGate.then(() =>
      secondClient.unregisterPushDevice("installation-second")
    );
    await signOut();
    releaseSignedOutPush();
    await delayedAfterSignOut;

    expect(requests.at(-1)).toEqual({
      authorization: null,
      method: "DELETE",
      url: "https://second.openteam.test/api/v0/notification-devices/installation-second",
    });
  });
});
