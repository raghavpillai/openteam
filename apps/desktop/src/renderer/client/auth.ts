import { resolveApiBase } from "./runtime-url";

const API_BASE = resolveApiBase(window.location.href, import.meta.env.VITE_OPENBOT_API_URL);

const TOKEN_KEY = "openbot:auth-token";
export const AUTH_REQUIRED_EVENT = "openbot:auth-required";

export const getAuthToken = (): string | null => localStorage.getItem(TOKEN_KEY);

const setAuthToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);

export const clearAuthToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
};

export const authHeaders = (): HeadersInit => {
  const token = getAuthToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};

const errorMessage = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    error?: { message?: string };
  } | null;
  return body?.error?.message || body?.message || `Sign-in failed (${response.status})`;
};

export const signIn = async (username: string, password: string): Promise<void> => {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: username.trim(), password, rememberMe: true }),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("The server did not return an OpenBot session token");
  setAuthToken(token);
};

export const hasValidSession = async (): Promise<boolean> => {
  const token = getAuthToken();
  if (!token) return false;
  try {
    const response = await fetch(`${API_BASE}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { session?: unknown; user?: unknown } | null;
    return Boolean(body?.session && body.user);
  } catch {
    // Preserve the token while the server is offline so the login screen can
    // report the real connection error once the user retries.
    return true;
  }
};
