import {
  createJsonTransport,
  normalizeBaseUrl,
  OpenTeamClientError,
  type OpenTeamFetch,
} from "./http";

export type OpenTeamAuthMode = "required" | "disabled";
export type OpenTeamAuthStatus = "checking" | "authenticated" | "signed-out";
export type OpenTeamAuthConnection = "unknown" | "online" | "offline";

export interface OpenTeamAuthUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  image: string | null;
}

export interface OpenTeamAuthSnapshot {
  status: OpenTeamAuthStatus;
  mode: OpenTeamAuthMode;
  connection: OpenTeamAuthConnection;
  error: string | null;
  user: OpenTeamAuthUser | null;
}

export interface OpenTeamAuthSession {
  session: unknown;
  user: OpenTeamAuthUser;
}

export interface OpenTeamSignInResult {
  token: string;
  user: OpenTeamAuthUser | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const parseAuthUser = (value: unknown): OpenTeamAuthUser | null => {
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
    (response.status === 401
      ? "The username or password is incorrect. Check your details and try again."
      : response.status === 403
        ? "This account cannot sign in to this server. Contact your server administrator."
        : response.status === 429
          ? "Too many sign-in attempts. Wait a moment and try again."
          : response.status >= 500
            ? "The server could not complete sign-in. Please try again shortly."
            : "Could not sign in. Please try again.")
  );
};

export interface OpenTeamAuthClientOptions {
  baseUrl: string;
  fetch?: OpenTeamFetch;
  /** Includes receiving and parsing the response body, not just connecting. */
  timeoutMs?: number;
}

const invalidOpenTeamServer = (status: number): OpenTeamClientError =>
  new OpenTeamClientError(
    "This endpoint is reachable, but it is not a compatible OpenTeam server.",
    "invalid_server",
    status
  );

const unavailableOpenTeamServer = (status: number): OpenTeamClientError =>
  new OpenTeamClientError("The OpenTeam server is temporarily unavailable.", "offline", status);

/**
 * Platform-neutral authentication protocol. Persistence and lifecycle policy stay
 * in the desktop/mobile adapters so secrets never cross into an unsafe storage API.
 */
export const createOpenTeamAuthClient = (options: OpenTeamAuthClientOptions) => {
  const transport = createJsonTransport(options);

  // A silent server (or stalled response body) must not leave onboarding permanently busy.
  const withDeadline = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new OpenTeamClientError(
            "The server took too long to respond. Please try again.",
            "timeout"
          )
        );
        controller.abort();
      }, options.timeoutMs ?? 15_000);
    });
    try {
      return await Promise.race([operation(controller.signal), deadline]);
    } finally {
      clearTimeout(timer!);
    }
  };

  const requestMode = (strict: boolean): Promise<OpenTeamAuthMode> =>
    withDeadline(async (signal) => {
      const response = await transport.open("/api/auth/config", { signal });
      if (!response.ok) {
        if (strict) {
          throw response.status >= 500
            ? unavailableOpenTeamServer(response.status)
            : invalidOpenTeamServer(response.status);
        }
        return "required";
      }
      const body = await responseBody(response);
      if (body?.mode === "required" || body?.mode === "disabled") return body.mode;
      if (strict) throw invalidOpenTeamServer(response.status);
      return "required";
    });

  const discoverMode = (): Promise<OpenTeamAuthMode> => requestMode(false);
  const validateServer = (): Promise<OpenTeamAuthMode> => requestMode(true);

  const signIn = (username: string, password: string): Promise<OpenTeamSignInResult> =>
    withDeadline(async (signal) => {
      const response = await transport.open("/api/auth/login", {
        method: "POST",
        signal,
        body: JSON.stringify({ username: username.trim(), password, rememberMe: true }),
      });
      if (!response.ok) throw new Error(await authResponseError(response));
      const token = response.headers.get("set-auth-token")?.trim() ?? "";
      if (!token) throw new Error("The server did not return an OpenTeam session token");
      const body = await responseBody(response);
      return { token, user: parseAuthUser(body?.user) };
    });

  const getSession = (token: string): Promise<OpenTeamAuthSession | null> =>
    withDeadline(async (signal) => {
      const response = await transport.open("/api/auth/get-session", {
        signal,
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const body = await responseBody(response);
      const user = parseAuthUser(body?.user);
      return body?.session && user ? { session: body.session, user } : null;
    });

  const signOut = (token: string): Promise<void> =>
    withDeadline(async (signal) => {
      await transport.open("/api/auth/sign-out", {
        method: "POST",
        signal,
        headers: { authorization: `Bearer ${token}` },
      });
    });

  return { baseUrl: transport.baseUrl, discoverMode, getSession, signIn, signOut, validateServer };
};

export type OpenTeamAuthClient = ReturnType<typeof createOpenTeamAuthClient>;

export interface OpenTeamAuthAssessment {
  status: Exclude<OpenTeamAuthStatus, "checking">;
  mode: OpenTeamAuthMode;
  connection: Exclude<OpenTeamAuthConnection, "unknown">;
  user: OpenTeamAuthUser | null;
  /** The server explicitly reported this mode, so a platform may cache it for offline starts. */
  observedMode: OpenTeamAuthMode | null;
  /** Invalid and auth-disabled sessions must be removed from platform-secure storage. */
  clearCredentials: boolean;
}

export interface AssessOpenTeamAuthSessionOptions {
  client: OpenTeamAuthClient;
  loadToken: () => Promise<string | null>;
  loadCachedMode?: () => Promise<OpenTeamAuthMode | null>;
  isCurrent?: () => boolean;
}

export class AuthSessionSupersededError extends Error {
  constructor() {
    super("The OpenTeam server changed while authentication was in progress.");
    this.name = "AuthSessionSupersededError";
  }
}

/** Shared fail-closed session policy; platforms retain ownership of secure persistence. */
export const assessOpenTeamAuthSession = async ({
  client,
  loadToken,
  loadCachedMode = async () => null,
  isCurrent = () => true,
}: AssessOpenTeamAuthSessionOptions): Promise<OpenTeamAuthAssessment> => {
  const ensureCurrent = () => {
    if (!isCurrent()) throw new AuthSessionSupersededError();
  };

  let mode: OpenTeamAuthMode = "required";
  let connection: Exclude<OpenTeamAuthConnection, "unknown"> = "online";
  let observedMode: OpenTeamAuthMode | null = null;
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

export const createAuthSnapshotStore = (initial: OpenTeamAuthSnapshot) => {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): OpenTeamAuthSnapshot => snapshot,
    publish: (next: OpenTeamAuthSnapshot): OpenTeamAuthSnapshot => {
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
