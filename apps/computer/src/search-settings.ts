import { isSearchProvider } from "@openteam/contracts/web-search";
import type { SearchConfiguration, SearchFetch } from "./search-provider";

/** Read for each search so saved DB changes take effect without restarting workers. */
export function serverSearchConfiguration(
  serverUrl: string,
  controlToken: string,
  request: SearchFetch = fetch
): (signal?: AbortSignal) => Promise<SearchConfiguration> {
  return async (signal) => {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await request(
        `${serverUrl.replace(/\/+$/, "")}/api/internal/server-settings/web-search/credentials`,
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
        (value.provider !== null && !isSearchProvider(value.provider)) ||
        (value.apiKey !== null &&
          (typeof value.apiKey !== "string" || !value.apiKey || value.apiKey.length > 20_000))
      )
        throw new Error("Invalid settings");
      signal?.throwIfAborted();
      return { provider: value.provider ?? undefined, apiKey: value.apiKey ?? undefined };
    } catch {
      signal?.throwIfAborted();
      // Neither upstream errors nor response bodies may expose credentials.
      throw new Error(
        "Web search settings could not be loaded. Check the server connection and saved key in Server settings."
      );
    }
  };
}
