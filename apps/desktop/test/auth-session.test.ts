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

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    dispatchEvent: () => true,
    location: { href: "http://127.0.0.1:8787" },
    openbot: {
      auth: {
        readToken: async () => ({ token: secureToken, persistence: "encrypted", backend: "test" }),
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
const user = {
  email: "owner@openbot.invalid",
  id: "owner-1",
  image: null,
  name: "owner",
  username: "owner",
};

globalThis.fetch = (async (input, init) => {
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

const auth = await import("../src/renderer/client/auth");

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
    expect(localStorage.getItem("openbot:auth-token")).toBeNull();

    await auth.signOut();

    // Other renderer tests may have initialized the shared same-origin HTTP
    // module first. This contract owns the authenticated path and method; URL
    // origin selection has its own runtime-url coverage.
    expect(
      calls.some(
        ({ method, url }) => method === "POST" && new URL(url).pathname === "/api/auth/sign-out"
      )
    ).toBe(true);
    expect(auth.getAuthToken()).toBeNull();
    expect(auth.getAuthSnapshot()).toEqual({
      mode: "required",
      status: "signed-out",
      connection: "online",
      error: null,
      user: null,
    });
  });
});
