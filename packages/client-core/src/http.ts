/** Minimal cross-platform fetch surface; avoids Bun/browser-specific static properties. */
export type OpenTeamFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenTeamTransportOptions {
  baseUrl: string;
  fetch?: OpenTeamFetch;
  getAuthToken?: () => string | null | Promise<string | null>;
  onUnauthorized?: (authToken: string | null) => void;
}

export class OpenTeamClientError extends Error {
  constructor(
    message: string,
    readonly code = "request_failed",
    readonly status = 0
  ) {
    super(message);
    this.name = "OpenTeamClientError";
  }
}

export const normalizeBaseUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("OpenTeam server URL is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid OpenTeam server URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The OpenTeam server URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Enter the server endpoint without a username or password.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Enter the server endpoint without a query or fragment.");
  }
  return trimmed.replace(/\/+$/, "");
};

export const normalizeOptionalBaseUrl = (value: string | null | undefined): string | null => {
  if (!value?.trim()) return null;
  return normalizeBaseUrl(value);
};

export const createJsonTransport = ({
  baseUrl,
  fetch: fetchOverride,
  getAuthToken,
  onUnauthorized,
}: OpenTeamTransportOptions) => {
  const origin = normalizeBaseUrl(baseUrl);
  const fetchImpl = fetchOverride ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("This platform does not provide fetch");

  const open = async (path: string, init?: RequestInit): Promise<Response> => {
    let response: Response;
    let requestAuthToken: string | null = null;
    try {
      const headers = new Headers(init?.headers);
      const explicitAuthorization = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      const token = explicitAuthorization ? null : await getAuthToken?.();
      requestAuthToken = explicitAuthorization?.trim() || token?.trim() || null;
      if (requestAuthToken && !explicitAuthorization) {
        headers.set("authorization", `Bearer ${requestAuthToken}`);
      }
      if (init?.body != null && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      response = await fetchImpl(`${origin}${path}`, { ...init, headers });
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      throw new OpenTeamClientError(
        error instanceof Error ? error.message : "OpenTeam server is unreachable",
        "offline"
      );
    }
    if (response.status === 401) onUnauthorized?.(requestAuthToken);
    return response;
  };

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await open(path, init);
    const text = await response.text();
    let body: {
      error?: { code?: string; message?: string };
    } & T;
    try {
      body = (text ? JSON.parse(text) : {}) as typeof body;
    } catch {
      if (!response.ok) {
        throw new OpenTeamClientError(
          `Request failed (${response.status})`,
          undefined,
          response.status
        );
      }
      throw new OpenTeamClientError("OpenTeam returned an invalid response", "invalid_response");
    }
    if (!response.ok) {
      throw new OpenTeamClientError(
        body.error?.message ?? `Request failed (${response.status})`,
        body.error?.code,
        response.status
      );
    }
    return body;
  };

  return { baseUrl: origin, open, request };
};
