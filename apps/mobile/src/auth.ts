import {
  AuthSessionSupersededError,
  assessOpenBotAuthSession,
  createOpenBotAuthClient,
  type OpenBotAuthUser,
  authHeadersForUrl as sharedAuthHeadersForUrl,
} from "@openbot/client-core/auth";
import { normalizeOptionalBaseUrl, OpenBotClientError } from "@openbot/client-core/http";
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "openbot.auth-token";
const TOKEN_SERVER_KEY = "openbot.auth-token-server";
const TOKEN_ACCOUNT_KEY = "openbot.auth-token-account";
const AUTH_MODE_KEY_PREFIX = "openbot.auth-mode.v1";

let token: string | null = null;
let accountId: string | null = null;
let authServerUrl: string | null = null;
let authServerGeneration = 0;
let authRequestGeneration = 0;
let ignoreStoredToken = false;
let tokenWriteGeneration = 0;
let tokenWriteTail: Promise<void> = Promise.resolve();
let authModeWriteTail: Promise<void> = Promise.resolve();
const authModeMemoryCache = new Map<string, CachedAuthMode>();
const authenticationRequiredListeners = new Set<() => void>();
const beforeSignOutListeners = new Set<() => void | Promise<void>>();

const normalizeAuthServer = (value: string | null): string | null =>
  normalizeOptionalBaseUrl(value);

const storeAuthToken = async (
  value: string | null,
  valueServerUrl = authServerUrl,
  valueAccountId = value ? accountId : null
): Promise<void> => {
  const generation = tokenWriteGeneration + 1;
  const tokenServerUrl = value ? normalizeAuthServer(valueServerUrl) : null;
  tokenWriteGeneration = generation;
  token = value;
  accountId = value ? valueAccountId : null;
  ignoreStoredToken = !value;
  const write = tokenWriteTail
    .catch(() => undefined)
    .then(async () => {
      if (generation !== tokenWriteGeneration) return;
      // Delete first so a crash can never pair an old bearer with a newly saved server.
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(TOKEN_ACCOUNT_KEY);
      if (value && tokenServerUrl) {
        await SecureStore.setItemAsync(TOKEN_SERVER_KEY, tokenServerUrl);
        if (valueAccountId) await SecureStore.setItemAsync(TOKEN_ACCOUNT_KEY, valueAccountId);
        // Commit the bearer last so a crash cannot expose a session without
        // its server and stable account identity already in place.
        await SecureStore.setItemAsync(TOKEN_KEY, value);
      } else {
        await SecureStore.deleteItemAsync(TOKEN_SERVER_KEY);
      }
    });
  tokenWriteTail = write;
  await write;
};

export const configureAuthServer = (value: string | null): string | null => {
  const nextServerUrl = normalizeAuthServer(value);
  if (authServerUrl === nextServerUrl) return authServerUrl;
  const previousServerUrl = authServerUrl;
  authServerGeneration += 1;
  authRequestGeneration += 1;
  authServerUrl = nextServerUrl;
  if (previousServerUrl) void storeAuthToken(null).catch(() => undefined);
  return authServerUrl;
};

export const getConfiguredAuthServer = (): string | null => authServerUrl;

const requireServerUrl = (value: string): string => {
  const configured = configureAuthServer(value);
  if (!configured) throw new Error("Enter your OpenBot server URL");
  return configured;
};

interface AuthServerLease {
  generation: number;
  serverUrl: string;
}

const captureAuthServerLease = (serverUrl: string): AuthServerLease => ({
  generation: authServerGeneration,
  serverUrl,
});

const authServerLeaseIsCurrent = (lease: AuthServerLease): boolean =>
  lease.generation === authServerGeneration && lease.serverUrl === authServerUrl;

const authRequestIsCurrent = (lease: AuthServerLease, generation: number): boolean =>
  generation === authRequestGeneration && authServerLeaseIsCurrent(lease);

const staleAuthOperation = (): Error =>
  new Error("The OpenBot server changed while authentication was in progress.");

type CachedAuthMode = "disabled" | "required";
export type OpenBotAuthMode = CachedAuthMode;
export type OpenBotServerConnectionResult = "authenticated" | "credentials-required";

export class OpenBotCredentialsRequiredError extends Error {
  constructor() {
    super("This server requires a username and password.");
    this.name = "OpenBotCredentialsRequiredError";
  }
}

const authModeOrigin = (serverUrl: string): string => new URL(serverUrl).origin;

const authModeKey = (origin: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of origin) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${AUTH_MODE_KEY_PREFIX}.${hash.toString(16).padStart(16, "0")}`;
};

const storeCachedAuthMode = async (serverUrl: string, mode: CachedAuthMode): Promise<void> => {
  const origin = authModeOrigin(serverUrl);
  const key = authModeKey(origin);
  const encoded = JSON.stringify({ mode, origin });
  authModeMemoryCache.set(origin, mode);
  const write = authModeWriteTail
    .catch(() => undefined)
    .then(async () => {
      if (mode !== "required") {
        await SecureStore.setItemAsync(key, encoded);
        return;
      }
      // Revoke a stale disabled grant first. If writing the richer tombstone then
      // fails, absence remains fail-closed on the next cold start.
      try {
        await SecureStore.deleteItemAsync(key);
      } catch (deleteError) {
        try {
          await SecureStore.setItemAsync(key, encoded);
          return;
        } catch {
          throw deleteError;
        }
      }
      await SecureStore.setItemAsync(key, encoded);
    });
  authModeWriteTail = write;
  await write;
};

const loadCachedAuthMode = async (serverUrl: string): Promise<CachedAuthMode | null> => {
  const origin = authModeOrigin(serverUrl);
  const inMemory = authModeMemoryCache.get(origin);
  if (inMemory) return inMemory;
  const stored = await SecureStore.getItemAsync(authModeKey(origin));
  if (!stored) return null;
  const parsed = JSON.parse(stored) as { mode?: unknown; origin?: unknown };
  if (parsed.origin !== origin) return null;
  return parsed.mode === "disabled" || parsed.mode === "required" ? parsed.mode : null;
};

export const cachedAuthModeForServer = (serverUrl: string): Promise<OpenBotAuthMode | null> =>
  loadCachedAuthMode(serverUrl);

export const loadAuthToken = async (): Promise<string | null> => {
  if (token) return token;
  await tokenWriteTail.catch(() => undefined);
  if (ignoreStoredToken) return null;
  const generation = tokenWriteGeneration;
  const [stored, storedServerUrl, storedAccountId] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(TOKEN_SERVER_KEY),
    SecureStore.getItemAsync(TOKEN_ACCOUNT_KEY),
  ]);
  if (generation !== tokenWriteGeneration || ignoreStoredToken) return token;
  if (stored && (!storedServerUrl || normalizeAuthServer(storedServerUrl) !== authServerUrl)) {
    await storeAuthToken(null);
    return null;
  }
  if (stored) {
    token = stored;
    accountId = storedAccountId;
  }
  return token;
};

export const getAuthToken = (): string | null => token;

/** Never allow a client retained for one server to borrow another server's session. */
export const getAuthTokenForServer = (serverUrl: string): string | null =>
  normalizeAuthServer(serverUrl) === authServerUrl ? token : null;

export const getAuthAccountIdForServer = (serverUrl: string): string | null =>
  normalizeAuthServer(serverUrl) === authServerUrl ? accountId : null;

export const authenticatedUserForServer = async (
  serverUrl: string
): Promise<OpenBotAuthUser | null> => {
  const normalized = normalizeAuthServer(serverUrl);
  if (!normalized || normalized !== authServerUrl) return null;
  const currentToken = (await loadAuthToken()) ?? getAuthTokenForServer(normalized);
  if (!currentToken || normalized !== authServerUrl) return null;
  return (await authClient(normalized).getSession(currentToken))?.user ?? null;
};

export const requireAuthentication = (): void => {
  authRequestGeneration += 1;
  void storeAuthToken(null).catch(() => undefined);
  for (const listener of authenticationRequiredListeners) listener();
};

export const requireAuthenticationForServer = (
  serverUrl: string,
  expectedToken?: string | null
): void => {
  if (normalizeAuthServer(serverUrl) !== authServerUrl) return;
  if (expectedToken !== undefined && expectedToken !== token) return;
  requireAuthentication();
};

export const onAuthenticationRequired = (listener: () => void): (() => void) => {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
};

export const onBeforeSignOut = (listener: () => void | Promise<void>): (() => void) => {
  beforeSignOutListeners.add(listener);
  return () => beforeSignOutListeners.delete(listener);
};

const authClient = (serverUrl: string) => createOpenBotAuthClient({ baseUrl: serverUrl });

export const signIn = async (
  serverUrl: string,
  username: string,
  password: string
): Promise<void> => {
  const configured = requireServerUrl(serverUrl);
  const lease = captureAuthServerLease(configured);
  const requestGeneration = authRequestGeneration + 1;
  authRequestGeneration = requestGeneration;
  let nextToken: string;
  let nextAccountId: string | null;
  try {
    const result = await authClient(configured).signIn(username, password);
    nextToken = result.token;
    nextAccountId = result.user?.id ?? null;
  } catch (error) {
    if (!authRequestIsCurrent(lease, requestGeneration)) throw staleAuthOperation();
    throw error;
  }
  if (!authRequestIsCurrent(lease, requestGeneration)) throw staleAuthOperation();
  await storeAuthToken(nextToken, configured, nextAccountId);
  if (!authRequestIsCurrent(lease, requestGeneration)) throw staleAuthOperation();
};

export const signOut = async (): Promise<void> => {
  const requestGeneration = authRequestGeneration + 1;
  authRequestGeneration = requestGeneration;
  const configured = authServerUrl;
  const currentToken = token;
  const lease = configured ? captureAuthServerLease(configured) : null;
  try {
    await Promise.allSettled([...beforeSignOutListeners].map((listener) => listener()));
    if (configured && currentToken) {
      await authClient(configured).signOut(currentToken);
    }
  } finally {
    if (
      requestGeneration === authRequestGeneration &&
      (!lease || authServerLeaseIsCurrent(lease))
    ) {
      try {
        await storeAuthToken(null);
      } finally {
        for (const listener of authenticationRequiredListeners) listener();
      }
    }
  }
};

export const hasValidSession = async (serverUrl: string): Promise<boolean> => {
  const configured = requireServerUrl(serverUrl);
  const lease = captureAuthServerLease(configured);
  const requestGeneration = authRequestGeneration + 1;
  authRequestGeneration = requestGeneration;
  try {
    const assessment = await assessOpenBotAuthSession({
      client: authClient(configured),
      loadToken: loadAuthToken,
      loadCachedMode: () => loadCachedAuthMode(configured).catch(() => null),
      isCurrent: () => authRequestIsCurrent(lease, requestGeneration),
    });
    if (assessment.observedMode) {
      const persistMode = storeCachedAuthMode(configured, assessment.observedMode);
      if (assessment.observedMode === "disabled") await persistMode.catch(() => undefined);
      else await persistMode;
    }
    if (!authRequestIsCurrent(lease, requestGeneration)) return false;
    if (assessment.clearCredentials) {
      const clear = storeAuthToken(null);
      if (assessment.mode === "disabled") await clear.catch(() => undefined);
      else await clear;
    } else if (assessment.user && token) {
      await storeAuthToken(token, configured, assessment.user.id);
    }
    return authRequestIsCurrent(lease, requestGeneration) && assessment.status === "authenticated";
  } catch (cause) {
    if (cause instanceof AuthSessionSupersededError) return false;
    throw cause;
  }
};

export const authenticateConnection = async (
  serverUrl: string,
  username: string,
  password: string
): Promise<void> => {
  if (await hasValidSession(serverUrl)) return;
  if (!username.trim() || !password) {
    try {
      await authClient(requireServerUrl(serverUrl)).discoverMode();
    } catch (cause) {
      if (cause instanceof OpenBotClientError && cause.code === "offline") {
        throw new Error(
          "Could not reach this OpenBot server. Check the endpoint and your connection."
        );
      }
      throw cause;
    }
    throw new OpenBotCredentialsRequiredError();
  }
  try {
    await signIn(serverUrl, username, password);
  } catch (cause) {
    if (cause instanceof OpenBotClientError && cause.code === "offline") {
      throw new Error(
        "Could not reach this OpenBot server. Check the endpoint and your connection."
      );
    }
    throw cause;
  }
};

export const testServerConnection = async (
  serverUrl: string
): Promise<OpenBotServerConnectionResult> => {
  const configured = requireServerUrl(serverUrl);
  try {
    const observedMode = await authClient(configured).validateServer();
    await storeCachedAuthMode(configured, observedMode);
  } catch (cause) {
    if (cause instanceof OpenBotClientError && cause.code === "offline") {
      throw new Error(
        "Could not reach this OpenBot server. Check the endpoint and your connection."
      );
    }
    throw cause;
  }
  return (await hasValidSession(configured)) ? "authenticated" : "credentials-required";
};

export const authHeadersForUrl = (url: string): Record<string, string> | undefined => {
  return sharedAuthHeadersForUrl(authServerUrl, token, url);
};
