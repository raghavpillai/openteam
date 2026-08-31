import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "openbot.auth-token";
export const serverUrl =
  process.env.EXPO_PUBLIC_OPENBOT_API_URL?.trim().replace(/\/+$/, "") || null;

let token: string | null = null;
const listeners = new Set<() => void>();

export const loadAuthToken = async (): Promise<string | null> => {
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  return token;
};

export const getAuthToken = (): string | null => token;

const storeAuthToken = async (value: string | null): Promise<void> => {
  token = value;
  if (value) await SecureStore.setItemAsync(TOKEN_KEY, value);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
};

export const requireAuthentication = (): void => {
  void storeAuthToken(null);
  for (const listener of listeners) listener();
};

export const onAuthenticationRequired = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const responseError = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    error?: { message?: string };
  } | null;
  return body?.error?.message || body?.message || `Sign-in failed (${response.status})`;
};

export const signIn = async (username: string, password: string): Promise<void> => {
  if (!serverUrl) return;
  const response = await fetch(`${serverUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: username.trim(), password, rememberMe: true }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const nextToken = response.headers.get("set-auth-token");
  if (!nextToken) throw new Error("The server did not return an OpenBot session token");
  await storeAuthToken(nextToken);
};

export const hasValidSession = async (): Promise<boolean> => {
  if (!serverUrl) return true;
  const stored = await loadAuthToken();
  if (!stored) return false;
  try {
    const response = await fetch(`${serverUrl}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${stored}` },
    });
    if (!response.ok) {
      await storeAuthToken(null);
      return false;
    }
    const body = (await response.json()) as { session?: unknown; user?: unknown } | null;
    return Boolean(body?.session && body.user);
  } catch {
    return true;
  }
};

export const authHeadersForUrl = (url: string): Record<string, string> | undefined => {
  if (!serverUrl || !token) return undefined;
  try {
    const target = new URL(url, serverUrl);
    const server = new URL(serverUrl);
    if (target.origin !== server.origin || !target.pathname.startsWith("/api/")) return undefined;
    return { authorization: `Bearer ${token}` };
  } catch {
    return undefined;
  }
};
