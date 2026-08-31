import { recordPerformance } from "../lib/performance";
import { clearAuthToken, getAuthToken } from "./auth";
import { resolveApiBase } from "./runtime-url";

export const API_BASE = resolveApiBase(window.location.href, import.meta.env.VITE_OPENBOT_API_URL);

export class ClientError extends Error {
  constructor(
    message: string,
    readonly code = "request_failed",
    readonly status = 0
  ) {
    super(message);
    this.name = "ClientError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const startedAt = performance.now();
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    const token = getAuthToken();
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (init?.body != null && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (error) {
    recordPerformance("api.request", performance.now() - startedAt, {
      path,
      status: 0,
      failed: true,
    });
    throw new ClientError(
      error instanceof Error ? error.message : "OpenBot server is unreachable",
      "offline"
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  } & T;
  recordPerformance("api.request", performance.now() - startedAt, {
    path,
    status: response.status,
    bytes: Number(response.headers.get("content-length") ?? 0),
    serverTiming: response.headers.get("server-timing") ?? "",
    failed: !response.ok,
  });
  if (!response.ok) {
    if (response.status === 401) clearAuthToken();
    throw new ClientError(
      body.error?.message ?? `Request failed (${response.status})`,
      body.error?.code,
      response.status
    );
  }
  return body;
}
