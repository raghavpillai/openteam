import {
  createJsonTransport,
  OpenBotClientError,
  type OpenBotFetch,
  type OpenBotTransportOptions,
} from "@openbot/client-core";
import { recordPerformance } from "../lib/performance";
import { clearAuthToken, getAuthToken } from "./auth";
import { resolveConfiguredApiBase } from "./runtime-url";

export const API_BASE = resolveConfiguredApiBase(
  window.location.href,
  localStorage,
  import.meta.env.VITE_OPENBOT_API_URL
);

const instrumentedFetch: OpenBotFetch = async (input, init) => {
  const startedAt = performance.now();
  try {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    recordPerformance("api.ttfb", performance.now() - startedAt, {
      path: new URL(url, API_BASE).pathname,
      status: response.status,
      bytes: Number(response.headers.get("content-length") ?? 0),
      serverTiming: response.headers.get("server-timing") ?? "",
      failed: !response.ok,
    });
    return response;
  } catch (error) {
    recordPerformance("api.ttfb", performance.now() - startedAt, {
      path:
        typeof input === "string"
          ? new URL(input, API_BASE).pathname
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname,
      status: 0,
      failed: true,
    });
    throw error;
  }
};

export const desktopTransportOptions: OpenBotTransportOptions = {
  baseUrl: API_BASE,
  fetch: instrumentedFetch,
  getAuthToken,
  onUnauthorized: clearAuthToken,
};

const transport = createJsonTransport(desktopTransportOptions);

export const request = transport.request;
export { OpenBotClientError as ClientError };
