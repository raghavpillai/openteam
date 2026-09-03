import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createOpenTeamClient } from "@openteam/client-core";

const secureValues = new Map<string, string>();
let delayedInstallationRead: { release: Promise<void>; started: () => void } | null = null;
let delayedPushToken: { release: Promise<void>; started: () => void } | null = null;

mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => {
    if (key === "openteam.push-installation-id" && delayedInstallationRead) {
      const delayed = delayedInstallationRead;
      delayedInstallationRead = null;
      delayed.started();
      await delayed.release;
    }
    return secureValues.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    secureValues.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureValues.delete(key);
  },
}));

mock.module("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "push-project" } } } },
}));

mock.module("react-native", () => ({ Platform: { OS: "ios" } }));

mock.module("expo-notifications", () => ({
  IosAuthorizationStatus: {
    AUTHORIZED: 2,
    PROVISIONAL: 3,
    EPHEMERAL: 4,
  },
  addPushTokenListener: () => ({ remove: () => undefined }),
  getExpoPushTokenAsync: async () => {
    if (delayedPushToken) {
      const delayed = delayedPushToken;
      delayedPushToken = null;
      delayed.started();
      await delayed.release;
    }
    return { data: "ExpoPushToken[delayed-origin-device]" };
  },
  getPermissionsAsync: async () => ({ canAskAgain: true, granted: true }),
  requestPermissionsAsync: async () => ({ canAskAgain: true, granted: true }),
  setBadgeCountAsync: async () => true,
  setNotificationHandler: () => undefined,
}));

const { getAuthTokenForServer, requireAuthenticationForServer, signIn, signOut } = await import(
  "../src/auth"
);
const { synchronizePushRegistration, unregisterPushInstallation } = await import(
  "../src/notifications"
);
const { coordinatePushRetirement } = await import("../src/push-retirement");
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
  secureValues.set("openteam.push-installation-id", "installation-device");
  delayedInstallationRead = null;
  delayedPushToken = null;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("push authentication origin isolation", () => {
  test("uses one installation identity across concurrent first registration and retirement", async () => {
    secureValues.delete("openteam.push-installation-id");
    const requests: Array<{
      installationId: string;
      method: string;
      url: string;
    }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/auth/login")) {
        return Response.json({}, { headers: { "set-auth-token": "push-session" } });
      }
      const method = init?.method ?? "GET";
      requests.push({
        installationId:
          method === "POST"
            ? (JSON.parse(String(init?.body)) as { installationId: string }).installationId
            : decodeURIComponent(requestUrl.split("/").at(-1) ?? ""),
        method,
        url: requestUrl,
      });
      return Response.json({});
    }) as typeof fetch;

    const serverUrl = "https://installation-race.openteam.test";
    await signIn(serverUrl, "owner", "password");
    const client = createOpenTeamClient({
      baseUrl: serverUrl,
      getAuthToken: () => getAuthTokenForServer(serverUrl),
      onUnauthorized: (usedToken) => requireAuthenticationForServer(serverUrl, usedToken),
    });
    const registrations = [
      synchronizePushRegistration(client, false),
      synchronizePushRegistration(client, false),
    ];
    const retirement = coordinatePushRetirement(
      registrations,
      () => unregisterPushInstallation(client),
      1_000
    );
    await Promise.all([retirement.bounded, retirement.eventual]);

    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST", "DELETE"]);
    expect(new Set(requests.map(({ installationId }) => installationId))).toHaveLength(1);
    expect(requests[0]?.installationId).toBe(secureValues.get("openteam.push-installation-id"));
  });

  test("drops delayed registration and cleanup after a switch or sign-out", async () => {
    const pushRequests: Array<{ authorization: string | null; url: string }> = [];
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
        pushRequests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          url: requestUrl,
        });
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
    let activeClient: unknown = firstClient;

    const tokenDelay = delay();
    delayedPushToken = { release: tokenDelay.pending, started: tokenDelay.markStarted };
    const staleRegistration = synchronizePushRegistration(
      firstClient,
      false,
      () => activeClient === firstClient
    );
    await tokenDelay.started;

    const installationDelay = delay();
    delayedInstallationRead = {
      release: installationDelay.pending,
      started: installationDelay.markStarted,
    };
    const staleUnregister = unregisterPushInstallation(
      firstClient,
      () => activeClient === firstClient
    );
    await installationDelay.started;

    await signIn("https://second.openteam.test", "owner", "password");
    activeClient = null;
    tokenDelay.release();
    installationDelay.release();
    await Promise.all([staleRegistration, staleUnregister]);

    expect(pushRequests).toEqual([]);

    const secondClient = createOpenTeamClient({
      baseUrl: "https://second.openteam.test",
      getAuthToken: () => getAuthTokenForServer("https://second.openteam.test"),
      onUnauthorized: (usedToken) =>
        requireAuthenticationForServer("https://second.openteam.test", usedToken),
    });
    activeClient = secondClient;
    const signOutDelay = delay();
    delayedInstallationRead = {
      release: signOutDelay.pending,
      started: signOutDelay.markStarted,
    };
    const staleAfterSignOut = unregisterPushInstallation(
      secondClient,
      () => activeClient === secondClient
    );
    await signOutDelay.started;
    await signOut();
    activeClient = null;
    signOutDelay.release();
    await staleAfterSignOut;

    expect(pushRequests).toEqual([]);
  });
});
