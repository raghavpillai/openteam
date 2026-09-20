import {
  assessOpenTeamAuthSession,
  createAuthSnapshotStore,
  createOpenTeamAuthClient,
  normalizeBaseUrl,
  type OpenTeamAuthSnapshot,
  type OpenTeamAuthUser,
  OpenTeamClientError,
  parseAuthUser,
} from "@openteam/client-core";
import { authErrorMessage } from "@openteam/product-core/auth-feedback";
import { resolveConfiguredApiBase } from "./runtime-url";
import { readNativeAuthWithDeadline } from "./native-auth-deadline";

export type {
  OpenTeamAuthConnection,
  OpenTeamAuthMode,
  OpenTeamAuthSnapshot,
  OpenTeamAuthStatus,
  OpenTeamAuthUser,
} from "@openteam/client-core";
export { parseAuthUser } from "@openteam/client-core";

const API_BASE = resolveConfiguredApiBase(
  window.location.href,
  localStorage,
  import.meta.env.VITE_OPENTEAM_API_URL
);
const LEGACY_TOKEN_KEY = "openteam:auth-token";
const USER_KEY = "openteam:auth-user";
export const AUTH_REQUIRED_EVENT = "openteam:auth-required";

const readCachedUser = (): OpenTeamAuthUser | null => {
  try {
    return parseAuthUser(JSON.parse(localStorage.getItem(USER_KEY) ?? "null"));
  } catch {
    return null;
  }
};

const cacheUser = (user: OpenTeamAuthUser | null): void => {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
};

const authStore = createAuthSnapshotStore({
  status: "checking",
  mode: "required",
  connection: "unknown",
  error: null,
  user: readCachedUser(),
});

export const getAuthSnapshot = authStore.getSnapshot;
export const subscribeAuthSnapshot = authStore.subscribe;

let token: string | null = null;
let desktopMachineId: string | undefined;
export const getDesktopMachineId = () => desktopMachineId;
let legacyToken: string | null = localStorage.getItem(LEGACY_TOKEN_KEY);
localStorage.removeItem(LEGACY_TOKEN_KEY);
let credentialGeneration = 0;
let tokenReadRequest: Promise<string | null> | null = null;
let refreshRequest: Promise<OpenTeamAuthSnapshot> | null = null;

const authClient = (baseUrl = API_BASE) => createOpenTeamAuthClient({ baseUrl });
const authBridge = () => window.openteam?.auth;

const requestSignIn = (baseUrl: string, username: string, password: string) => {
  const bridge = authBridge();
  return bridge
    ? bridge.signIn(baseUrl, username, password)
    : authClient(baseUrl).signIn(username, password);
};

const loadAuthToken = (): Promise<string | null> => {
  if (token) return Promise.resolve(token);
  if (tokenReadRequest) return tokenReadRequest;
  const generation = credentialGeneration;
  tokenReadRequest = (async () => {
    let stored: string | null = null;
    const bridge = authBridge();
    if (bridge) stored = (await readNativeAuthWithDeadline(bridge.readToken())).token;
    if (generation !== credentialGeneration) return token;
    const next = stored || legacyToken;
    legacyToken = null;
    if (!stored && next && bridge) {
      // One-time migration from the old renderer localStorage token. It was
      // deleted synchronously above before any network request can use it.
      await bridge.writeToken(next);
    }
    if (generation !== credentialGeneration) return token;
    token = next;
    return token;
  })().finally(() => {
    tokenReadRequest = null;
  });
  return tokenReadRequest;
};

const persistAuthToken = async (next: string | null): Promise<void> => {
  if (!next) desktopMachineId = undefined;
  const generation = ++credentialGeneration;
  legacyToken = null;
  const bridge = authBridge();
  if (!next) token = null;
  if (bridge) {
    if (next) await bridge.writeToken(next);
    else await bridge.clearToken().catch(() => undefined);
  }
  if (generation !== credentialGeneration) throw new Error("Sign-in was cancelled. Please try again.");
  token = next;
};

const removeAuthCredentials = async (): Promise<void> => {
  await persistAuthToken(null);
  cacheUser(null);
};

export const getAuthToken = (): string | null => token;

export const clearAuthToken = (expectedToken?: string | null): void => {
  if (expectedToken !== undefined && expectedToken !== token) return;
  credentialGeneration += 1;
  token = null;
  legacyToken = null;
  cacheUser(null);
  void authBridge()
    ?.clearToken()
    .catch(() => undefined);
  authStore.publish({
    status: "signed-out",
    mode: "required",
    connection: "online",
    error: null,
    user: null,
  });
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
};

export const authHeaders = (): HeadersInit => {
  const currentToken = getAuthToken();
  return currentToken ? { authorization: `Bearer ${currentToken}` } : {};
};

export const refreshAuthSession = (): Promise<OpenTeamAuthSnapshot> => {
  if (refreshRequest) return refreshRequest;
  authStore.publish({ ...authStore.getSnapshot(), status: "checking", error: null });
  refreshRequest = (async () => {
    const assessment = await assessOpenTeamAuthSession({
      client: authClient(),
      loadToken: loadAuthToken,
    });
    if (assessment.clearCredentials) await removeAuthCredentials();
    if (assessment.user) cacheUser(assessment.user);
    if (assessment.status === "authenticated") void authBridge()?.connectMachine?.(API_BASE).then(result => { desktopMachineId = result.machineId; }).catch(() => undefined);
    return authStore.publish({
      status: assessment.status,
      mode: assessment.mode,
      connection: assessment.connection,
      error: null,
      user:
        assessment.user ??
        (assessment.status === "authenticated" && assessment.mode === "required"
          ? readCachedUser()
          : null),
    });
  })()
    .catch((cause) =>
      authStore.publish({
        status: "signed-out",
        mode: "required",
        connection: "unknown",
        error: authErrorMessage(cause, "Could not restore your sign-in. Please sign in again."),
        user: null,
      })
    )
    .finally(() => {
      refreshRequest = null;
    });
  return refreshRequest;
};

export const signIn = async (username: string, password: string): Promise<OpenTeamAuthSnapshot> => {
  const result = await requestSignIn(API_BASE, username, password);
  await persistAuthToken(result.token);
  cacheUser(result.user);
  const session = await refreshAuthSession();
  if (session.status !== "authenticated") {
    throw new Error(session.error ?? "The server could not verify your sign-in. Please try again.");
  }
  return session;
};

export interface OpenTeamServerConnection {
  baseUrl: string;
  mode: "required" | "disabled";
}

export const testServerConnection = async (
  serverUrl: string
): Promise<OpenTeamServerConnection> => {
  const baseUrl = normalizeBaseUrl(serverUrl);
  try {
    return { baseUrl, mode: await authClient(baseUrl).validateServer() };
  } catch (cause) {
    if (cause instanceof OpenTeamClientError && cause.code === "offline" && cause.status === 0) {
      throw new Error(
        "Could not reach this OpenTeam server. Check the endpoint and your connection."
      );
    }
    throw cause;
  }
};

export const clearAuthCredentialsForServerChange = async (): Promise<void> => {
  await removeAuthCredentials();
  authStore.publish({
    status: "signed-out",
    mode: "required",
    connection: "online",
    error: null,
    user: null,
  });
};

export const signInToServer = async (
  serverUrl: string,
  username: string,
  password: string
): Promise<void> => {
  const result = await requestSignIn(normalizeBaseUrl(serverUrl), username, password);
  await persistAuthToken(result.token);
  cacheUser(result.user);
};

export const signOut = async (): Promise<void> => {
  const currentToken = token ?? (await loadAuthToken());
  try {
    if (currentToken) {
      const bridge = authBridge();
      if (bridge) await bridge.signOut(API_BASE, currentToken);
      else await authClient().signOut(currentToken);
    }
  } catch {
    // Local sign-out must still succeed if the server is unavailable.
  } finally {
    clearAuthToken(currentToken);
  }
};

export const hasValidSession = async (): Promise<boolean> =>
  (await refreshAuthSession()).status === "authenticated";
