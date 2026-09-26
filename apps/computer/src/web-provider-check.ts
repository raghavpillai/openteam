import {
  type FetchProvider,
  isFetchProvider,
  isSearchProvider,
  type SearchProvider,
  type WebProviderCheckRequest,
  type WebProviderCheckResult,
} from "@openteam/contracts/web-search";
import { builtinFetch } from "./builtin-fetch";
import { FetchProviderClient } from "./fetch-provider";
import { SearchProviderClient, type SearchFetch } from "./search-provider";

const CHECK_QUERY = "OpenTeam open source AI agents";
const CHECK_URL = "https://example.com/";

export function parseWebProviderCheck(input: unknown): WebProviderCheckRequest {
  const value = (input ?? {}) as Record<string, unknown>;
  if (
    !["search", "fetch"].includes(value.tool as string) ||
    !(value.tool === "search" ? isSearchProvider(value.provider) : isFetchProvider(value.provider)) ||
    (value.apiKey !== null && (typeof value.apiKey !== "string" || !value.apiKey || value.apiKey.length > 20_000))
  )
    throw new Error("Invalid web provider check");
  return { tool: value.tool, provider: value.provider, apiKey: value.apiKey } as WebProviderCheckRequest;
}

/** Runs one real search or fetch with the given configuration, exactly as the agent's tools
 * would, and reports whether it worked. Failures are results, not errors. */
export async function checkWebProvider(
  request: WebProviderCheckRequest,
  signal?: AbortSignal,
  http: SearchFetch = fetch
): Promise<WebProviderCheckResult> {
  const configuration = { apiKey: request.apiKey ?? undefined };
  try {
    if (request.tool === "search") {
      const client = new SearchProviderClient(() => ({ ...configuration, provider: request.provider as SearchProvider }), http);
      const { details } = await client.search(CHECK_QUERY, signal);
      const count = details.results.length;
      return count
        ? { ok: true, message: `Search works: ${count} result${count === 1 ? "" : "s"} for a test query.` }
        : { ok: false, message: "The provider answered, but returned no results for a test query." };
    }
    const provided = await new FetchProviderClient(
      () => ({ ...configuration, provider: request.provider as FetchProvider }),
      http
    ).fetch(CHECK_URL, signal);
    if (!provided.configured) return { ok: false, message: provided.message };
    const text = provided.provider === "builtin" ? (await builtinFetch(CHECK_URL, signal)).text : provided.text;
    return /Example Domain/i.test(text)
      ? { ok: true, message: `Fetch works: read example.com (${text.length.toLocaleString("en-US")} characters).` }
      : { ok: false, message: "The provider answered, but the test page's text was missing." };
  } catch (error) {
    signal?.throwIfAborted();
    return { ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}
