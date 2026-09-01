import { createJsonTransport, normalizeBaseUrl, type OpenBotFetch } from "./http";

export type OpenBotAuthMode = "required" | "disabled";
export type OpenBotAuthStatus = "checking" | "authenticated" | "signed-out";
export type OpenBotAuthConnection = "unknown" | "online" | "offline";

export interface OpenBotAuthUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  image: string | null;
}

export interface OpenBotAuthSnapshot {
  status: OpenBotAuthStatus;
  mode: OpenBotAuthMode;
  connection: OpenBotAuthConnection;
  error: string | null;
  user: OpenBotAuthUser | null;
}

export interface OpenBotAuthSession {
  session: unknown;
  user: OpenBotAuthUser;
}

export interface OpenBotSignInResult {
  token: string;
  user: OpenBotAuthUser | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const parseAuthUser = (value: unknown): OpenBotAuthUser | null => {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim() : "";
  if (!id || (!name && !email)) return null;
  return {
    id,
    name: name || email,
    email,
    username:
      typeof value.username === "string" && value.username.trim() ? value.username.trim() : null,
    image: typeof value.image === "string" && value.image.trim() ? value.image.trim() : null,
  };
};

const responseBody = async (response: Response): Promise<Record<string, unknown> | null> => {
  const value = (await response.json().catch(() => null)) as unknown;
  return isRecord(value) ? value : null;
};

export const authResponseError = async (response: Response): Promise<string> => {
  const body = await responseBody(response);
  const nested = isRecord(body?.error) ? body.error : null;
  return (
    (typeof nested?.message === "string" && nested.message) ||
    (typeof body?.message === "string" && body.message) ||
    `Sign-in failed (${response.status})`
  );
};

export interface OpenBotAuthClientOptions {
  baseUrl: string;
  fetch?: OpenBotFetch;
}

/**
 * Platform-neutral authentication protocol. Persistence and lifecycle policy stay
 * in the desktop/mobile adapters so secrets never cross into an unsafe storage API.
 */
export const createOpenBotAuthClient = (options: OpenBotAuthClientOptions) => {
  const transport = createJsonTransport(options);

  const discoverMode = async (): Promise<OpenBotAuthMode> => {
    const response = await transport.open("/api/auth/config");
    if (!response.ok) return "required";
    const body = await responseBody(response);
    return body?.mode === "disabled" ? "disabled" : "required";
  };

  const signIn = async (username: string, password: string): Promise<OpenBotSignInResult> => {
    const response = await transport.open("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: username.trim(), password, rememberMe: true }),
    });
    if (!response.ok) throw new Error(await authResponseError(response));
    const token = response.headers.get("set-auth-token")?.trim() ?? "";
    if (!token) throw new Error("The server did not return an OpenBot session token");
    const body = await responseBody(response);
    return { token, user: parseAuthUser(body?.user) };
  };

  const getSession = async (token: string): Promise<OpenBotAuthSession | null> => {
    const response = await transport.open("/api/auth/get-session", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = await responseBody(response);
    const user = parseAuthUser(body?.user);
    return body?.session && user ? { session: body.session, user } : null;
  };

  const signOut = async (token: string): Promise<void> => {
    await transport.open("/api/auth/sign-out", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  };

  return { baseUrl: transport.baseUrl, discoverMode, getSession, signIn, signOut };
};

export type OpenBotAuthClient = ReturnType<typeof createOpenBotAuthClient>;

export interface OpenBotAuthAssessment {
  status: Exclude<OpenBotAuthStatus, "checking">;
  mode: OpenBotAuthMode;
  connection: Exclude<OpenBotAuthConnection, "unknown">;
  user: OpenBotAuthUser | null;
  /** The server explicitly reported this mode, so a platform may cache it for offline starts. */
  observedMode: OpenBotAuthMode | null;
  /** Invalid and auth-disabled sessions must be removed from platform-secure storage. */
  clearCredentials: boolean;
}

export interface AssessOpenBotAuthSessionOptions {
  client: OpenBotAuthClient;
  loadToken: () => Promise<string | null>;
  loadCachedMode?: () => Promise<OpenBotAuthMode | null>;
  isCurrent?: () => boolean;
}

export class AuthSessionSupersededError extends Error {
  constructor() {
    super("The OpenBot server changed while authentication was in progress.");
    this.name = "AuthSessionSupersededError";
  }
}

/** Shared fail-closed session policy; platforms retain ownership of secure persistence. */
export const assessOpenBotAuthSession = async ({
  client,
  loadToken,
  loadCachedMode = async () => null,
  isCurrent = () => true,
}: AssessOpenBotAuthSessionOptions): Promise<OpenBotAuthAssessment> => {
  const ensureCurrent = () => {
    if (!isCurrent()) throw new AuthSessionSupersededError();
  };

  let mode: OpenBotAuthMode = "required";
  let connection: Exclude<OpenBotAuthConnection, "unknown"> = "online";
  let observedMode: OpenBotAuthMode | null = null;
  try {
    mode = await client.discoverMode();
    ensureCurrent();
    observedMode = mode;
  } catch (cause) {
    if (cause instanceof AuthSessionSupersededError) throw cause;
    ensureCurrent();
    connection = "offline";
    mode = (await loadCachedMode()) ?? "required";
    ensureCurrent();
  }

  if (mode === "disabled") {
    return {
      status: "authenticated",
      mode,
      connection,
      user: null,
      observedMode,
      clearCredentials: true,
    };
  }

  const token = await loadToken();
  ensureCurrent();
  if (!token) {
    return {
      status: "signed-out",
      mode,
      connection,
      user: null,
      observedMode,
      clearCredentials: false,
    };
  }

  try {
    const session = await client.getSession(token);
    ensureCurrent();
    if (session) {
      return {
        status: "authenticated",
        mode,
        connection: "online",
        user: session.user,
        observedMode,
        clearCredentials: false,
      };
    }
    return {
      status: "signed-out",
      mode,
      connection: "online",
      user: null,
      observedMode,
      clearCredentials: true,
    };
  } catch (cause) {
    if (cause instanceof AuthSessionSupersededError) throw cause;
    ensureCurrent();
    // A previously established credential remains usable during a temporary outage.
    return {
      status: "authenticated",
      mode,
      connection: "offline",
      user: null,
      observedMode,
      clearCredentials: false,
    };
  }
};

export const createAuthSnapshotStore = (initial: OpenBotAuthSnapshot) => {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): OpenBotAuthSnapshot => snapshot,
    publish: (next: OpenBotAuthSnapshot): OpenBotAuthSnapshot => {
      snapshot = next;
      for (const listener of listeners) listener();
      return snapshot;
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const authHeadersForUrl = (
  baseUrl: string | null,
  token: string | null,
  url: string
): Record<string, string> | undefined => {
  if (!baseUrl || !token) return undefined;
  try {
    const server = new URL(normalizeBaseUrl(baseUrl));
    const target = new URL(url, server);
    if (target.origin !== server.origin || !target.pathname.startsWith("/api/")) return undefined;
    return { authorization: `Bearer ${token}` };
  } catch {
    return undefined;
  }
};
