import type { FetchConfiguration } from "./fetch-provider";
import { isSearchProvider, isFetchProvider } from "@openteam/contracts/web-search";
import type { SearchConfiguration, SearchFetch } from "./search-provider";

/** Read for each search so saved DB changes take effect without restarting workers. */
function serverWebConfiguration(
  kind: "search" | "fetch",
  serverUrl: string,
  controlToken: string,
  request: SearchFetch = fetch
) {
  return async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await request(
        `${serverUrl.replace(/\/+$/, "")}/api/internal/server-settings/web-${kind}/credentials`,
        {
          headers: { authorization: `Bearer ${controlToken}` },
          redirect: "error",
          cache: "no-store",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        }
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Settings unavailable");
      }
      const value = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value.provider !== null &&
          (kind === "fetch"
            ? !isFetchProvider(value.provider)
            : !isSearchProvider(value.provider))) ||
        (value.apiKey !== null &&
          (typeof value.apiKey !== "string" || !value.apiKey || value.apiKey.length > 20_000))
      )
        throw new Error("Invalid settings");
      signal?.throwIfAborted();
      // Keep null distinct: for fetch it means the user turned fetch off.
      return { provider: value.provider, apiKey: value.apiKey ?? undefined };
    } catch {
      signal?.throwIfAborted();
      // Neither upstream errors nor response bodies may expose credentials.
      throw new Error(
        `Web ${kind} settings could not be loaded from the OpenTeam server, so nothing was ${kind === "search" ? "searched" : "fetched"}. Retry shortly; if it keeps failing, the server may need attention.`
      );
    }
  };
}

export function serverSearchConfiguration(
  serverUrl: string,
  controlToken: string,
  request: SearchFetch = fetch
): (signal?: AbortSignal) => Promise<SearchConfiguration> {
  return serverWebConfiguration("search", serverUrl, controlToken, request);
}
export function serverFetchConfiguration(
  serverUrl: string,
  controlToken: string,
  request: SearchFetch = fetch
): (signal?: AbortSignal) => Promise<FetchConfiguration> {
  return serverWebConfiguration("fetch", serverUrl, controlToken, request);
}
