import {
  assessOpenBotAuthSession,
  createAuthSnapshotStore,
  createOpenBotAuthClient,
  parseAuthUser,
  type OpenBotAuthSnapshot,
  type OpenBotAuthUser,
} from "@openbot/client-core";
import { resolveApiBase } from "./runtime-url";

export type {
  OpenBotAuthConnection,
  OpenBotAuthMode,
  OpenBotAuthSnapshot,
  OpenBotAuthStatus,
  OpenBotAuthUser,
} from "@openbot/client-core";
export { parseAuthUser } from "@openbot/client-core";

const API_BASE = resolveApiBase(window.location.href, import.meta.env.VITE_OPENBOT_API_URL);
const LEGACY_TOKEN_KEY = "openbot:auth-token";
const USER_KEY = "openbot:auth-user";
export const AUTH_REQUIRED_EVENT = "openbot:auth-required";

const readCachedUser = (): OpenBotAuthUser | null => {
  try {
    return parseAuthUser(JSON.parse(localStorage.getItem(USER_KEY) ?? "null"));
  } catch {
    return null;
  }
};

const cacheUser = (user: OpenBotAuthUser | null): void => {
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
let legacyToken: string | null = localStorage.getItem(LEGACY_TOKEN_KEY);
localStorage.removeItem(LEGACY_TOKEN_KEY);
let credentialGeneration = 0;
let tokenReadRequest: Promise<string | null> | null = null;
let refreshRequest: Promise<OpenBotAuthSnapshot> | null = null;

const authClient = () => createOpenBotAuthClient({ baseUrl: API_BASE });
const authBridge = () => window.openbot?.auth;

const loadAuthToken = (): Promise<string | null> => {
  if (token) return Promise.resolve(token);
  if (tokenReadRequest) return tokenReadRequest;
  const generation = credentialGeneration;
  tokenReadRequest = (async () => {
    let stored: string | null = null;
    const bridge = authBridge();
    if (bridge) stored = (await bridge.readToken()).token;
    if (generation !== credentialGeneration) return token;
    const next = stored || legacyToken;
    legacyToken = null;
    token = next;
    if (!stored && next && bridge) {
      // One-time migration from the old renderer localStorage token. It was
      // deleted synchronously above before any network request can use it.
      await bridge.writeToken(next).catch(() => undefined);
    }
    return token;
  })().finally(() => {
    tokenReadRequest = null;
  });
  return tokenReadRequest;
};

const persistAuthToken = async (next: string | null): Promise<void> => {
  credentialGeneration += 1;
  legacyToken = null;
  token = next;
  const bridge = authBridge();
  if (!bridge) return;
  if (next) await bridge.writeToken(next).catch(() => undefined);
  else await bridge.clearToken().catch(() => undefined);
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

export const refreshAuthSession = (): Promise<OpenBotAuthSnapshot> => {
  if (refreshRequest) return refreshRequest;
  authStore.publish({ ...authStore.getSnapshot(), status: "checking", error: null });
  refreshRequest = (async () => {
    const assessment = await assessOpenBotAuthSession({
      client: authClient(),
      loadToken: loadAuthToken,
    });
    if (assessment.clearCredentials) await removeAuthCredentials();
    if (assessment.user) cacheUser(assessment.user);
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
  })().finally(() => {
    refreshRequest = null;
  });
  return refreshRequest;
};

export const signIn = async (username: string, password: string): Promise<OpenBotAuthSnapshot> => {
  const result = await authClient().signIn(username, password);
  await persistAuthToken(result.token);
  cacheUser(result.user);
  return refreshAuthSession();
};

export const signOut = async (): Promise<void> => {
  const currentToken = token ?? (await loadAuthToken());
  try {
    if (currentToken) await authClient().signOut(currentToken);
  } catch {
    // Local sign-out must still succeed if the server is unavailable.
  } finally {
    clearAuthToken(currentToken);
  }
};

export const hasValidSession = async (): Promise<boolean> =>
  (await refreshAuthSession()).status === "authenticated";
