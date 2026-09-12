import { afterAll, describe, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

const values = new Map<string, string>();
const storage: Storage = {
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  get length() {
    return values.size;
  },
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, value),
};
let secureToken: string | null = null;
let failTokenRead = false;

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    dispatchEvent: () => true,
    location: { href: "http://127.0.0.1:8787" },
    openteam: {
      auth: {
        signIn: async (serverUrl: string, username: string, password: string) => {
          nativeCalls.push({ method: "signIn", serverUrl, username, password });
          return { token: "test-session-token", user };
        },
        signOut: async (serverUrl: string, token: string) => {
          nativeCalls.push({ method: "signOut", serverUrl, token });
        },
        readToken: async () => {
          if (failTokenRead) throw new Error("Keychain unavailable: native diagnostic");
          return { token: secureToken, persistence: "encrypted", backend: "test" };
        },
        writeToken: async (token: string) => {
          secureToken = token;
          return { token, persistence: "encrypted", backend: "test" };
        },
        clearToken: async () => {
          secureToken = null;
          return { token: null, persistence: "encrypted", backend: "test" };
        },
      },
    },
  },
});

const calls: Array<{ method: string; url: string }> = [];
const nativeCalls: Array<Record<string, string>> = [];
const user = {
  email: "owner@openteam.invalid",
  id: "owner-1",
  image: null,
  name: "owner",
  username: "owner",
};

const openTeamFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, url });
  if (url.endsWith("/api/auth/login")) {
    return Response.json({ user }, { headers: { "set-auth-token": "test-session-token" } });
  }
  if (url.endsWith("/api/auth/config")) return Response.json({ mode: "required" });
  if (url.endsWith("/api/auth/get-session")) {
    return Response.json({ session: { id: "session-1" }, user });
  }
  if (url.endsWith("/api/auth/sign-out")) return new Response(null, { status: 204 });
  return new Response(null, { status: 404 });
}) as typeof fetch;
globalThis.fetch = openTeamFetch;

const auth = await import("../../src/renderer/client/auth");

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("desktop authenticated session", () => {
  test("publishes the logged-in owner and clears it on sign-out", async () => {
    const connection = await auth.testServerConnection("https://bots.example.test/");
    expect(connection).toEqual({ baseUrl: "https://bots.example.test", mode: "required" });
    expect(calls.at(-1)?.url).toBe("https://bots.example.test/api/auth/config");

    const signedIn = await auth.signIn("owner", "secret");

    expect(signedIn).toEqual({
      mode: "required",
      status: "authenticated",
      connection: "online",
      error: null,
      user,
    });
    expect(auth.getAuthToken()).toBe("test-session-token");
    expect(secureToken).toBe("test-session-token");
    expect(localStorage.getItem("openteam:auth-token")).toBeNull();
    expect(nativeCalls.at(-1)).toMatchObject({
      method: "signIn",
      username: "owner",
      password: "secret",
    });

    await auth.signOut();

    expect(nativeCalls.at(-1)).toMatchObject({ method: "signOut", token: "test-session-token" });
    expect(calls.some(({ method }) => method === "POST")).toBe(false);
    expect(auth.getAuthToken()).toBeNull();
    expect(auth.getAuthSnapshot()).toEqual({
      mode: "required",
      status: "signed-out",
      connection: "online",
      error: null,
      user: null,
    });
  });

  test("uses native login for a newly selected remote server", async () => {
    await auth.signInToServer("http://100.94.42.50:8787/", "owner", "secret");
    expect(nativeCalls.at(-1)).toEqual({
      method: "signIn",
      serverUrl: "http://100.94.42.50:8787",
      username: "owner",
      password: "secret",
    });
    expect(secureToken).toBe("test-session-token");
    await auth.clearAuthCredentialsForServerChange();
  });

  test("rejects a reachable website that is not an OpenTeam server", async () => {
    globalThis.fetch = (async () => new Response("Not found", { status: 404 })) as typeof fetch;
    try {
      await expect(auth.testServerConnection("https://google.example.test")).rejects.toThrow(
        "not a compatible OpenTeam server"
      );
    } finally {
      globalThis.fetch = openTeamFetch;
    }
  });

  test("leaves startup checking with a readable error when secure storage fails, then retries", async () => {
    await auth.clearAuthCredentialsForServerChange();
    failTokenRead = true;
    try {
      const snapshot = await auth.refreshAuthSession();
      expect(snapshot.status).toBe("signed-out");
      expect(snapshot.user).toBeNull();
      expect(snapshot.error).toBe(
        "OpenTeam could not access your saved sign-in. Restart the app and try again."
      );
    } finally {
      failTokenRead = false;
    }
    expect((await auth.refreshAuthSession()).error).toBeNull();
    expect((await auth.signIn("owner", "secret")).status).toBe("authenticated");
    await auth.signOut();
  });

  test("reports rejected session verification instead of silently returning to the form", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/api/auth/get-session")
        ? new Response(null, { status: 401 })
        : openTeamFetch(input, init)) as typeof fetch;
    try {
      await expect(auth.signIn("owner", "secret")).rejects.toThrow(
        "The server could not verify your sign-in. Please try again."
      );
      expect(auth.getAuthToken()).toBeNull();
      expect(auth.getAuthSnapshot().status).toBe("signed-out");
    } finally {
      globalThis.fetch = openTeamFetch;
    }
  });
});
