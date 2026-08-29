export interface OpenBotTransportOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export class OpenBotClientError extends Error {
  constructor(
    message: string,
    readonly code = "request_failed",
    readonly status = 0
  ) {
    super(message);
    this.name = "OpenBotClientError";
  }
}

export const normalizeBaseUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("OpenBot server URL is required");
  return trimmed.replace(/\/+$/, "");
};

export const createJsonTransport = ({ baseUrl, fetch: fetchOverride }: OpenBotTransportOptions) => {
  const origin = normalizeBaseUrl(baseUrl);
  const fetchImpl = fetchOverride ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("This platform does not provide fetch");

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try {
      const headers = new Headers(init?.headers);
      if (init?.body != null && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      response = await fetchImpl(`${origin}${path}`, { ...init, headers });
    } catch (error) {
      throw new OpenBotClientError(
        error instanceof Error ? error.message : "OpenBot server is unreachable",
        "offline"
      );
    }

    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as {
      error?: { code?: string; message?: string };
    } & T;
    if (!response.ok) {
      throw new OpenBotClientError(
        body.error?.message ?? `Request failed (${response.status})`,
        body.error?.code,
        response.status
      );
    }
    return body;
  };

  return { baseUrl: origin, request };
};
