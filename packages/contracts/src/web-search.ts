/** Web search and web fetch are configured separately: each tool has its own provider list,
 * credentials and connection checks, stored on the server. */

export type WebTool = "search" | "fetch";
export const WEB_TOOLS: readonly WebTool[] = ["search", "fetch"];

export interface WebProviderField {
  /** A provider's API key, its one secret. */
  id: "apiKey";
  label: string;
  secret: true;
  required: boolean;
  placeholder?: string;
}

export interface WebProviderInfo {
  id: string;
  name: string;
  /** Icon asset name shared by desktop and iOS (`web-provider-<brand>`). */
  brand: string;
  description: string;
  fields: readonly WebProviderField[];
  /** Where to create an API key. */
  setupUrl?: string;
}

const apiKey = (): WebProviderField => ({ id: "apiKey", label: "API key", secret: true, required: true, placeholder: "API key" });

/** Every third-party provider needs its own API key; only the built-in fetcher works without one. */
export const SEARCH_PROVIDER_LIST = [
  { id: "exa", name: "Exa", brand: "exa", description: "AI search with page highlights.", fields: [apiKey()], setupUrl: "https://dashboard.exa.ai/api-keys" },
  { id: "brave", name: "Brave Search", brand: "brave", description: "Results from Brave's independent index.", fields: [apiKey()], setupUrl: "https://api-dashboard.search.brave.com/app/keys" },
  { id: "parallel", name: "Parallel", brand: "parallel", description: "Search built for AI agents.", fields: [apiKey()], setupUrl: "https://platform.parallel.ai" },
  { id: "firecrawl", name: "Firecrawl", brand: "firecrawl", description: "Web search with page summaries.", fields: [apiKey()], setupUrl: "https://www.firecrawl.dev/app/api-keys" },
  { id: "bing-serpapi", name: "Bing", brand: "bing", description: "Bing results through a SerpApi key.", fields: [apiKey()], setupUrl: "https://serpapi.com/manage-api-key" },
  { id: "perplexity", name: "Perplexity", brand: "perplexity", description: "Results from Perplexity's search index.", fields: [apiKey()], setupUrl: "https://www.perplexity.ai/account/api/keys" },
] as const satisfies readonly WebProviderInfo[];

export const FETCH_PROVIDER_LIST = [
  { id: "builtin", name: "Built-in", brand: "openteam", description: "Reads public pages from your server. Can't run JavaScript.", fields: [] },
  { id: "exa", name: "Exa", brand: "exa", description: "Live-crawled page text.", fields: [apiKey()], setupUrl: "https://dashboard.exa.ai/api-keys" },
  { id: "parallel", name: "Parallel", brand: "parallel", description: "Full page content, including PDFs.", fields: [apiKey()], setupUrl: "https://platform.parallel.ai" },
  { id: "firecrawl", name: "Firecrawl", brand: "firecrawl", description: "Renders JavaScript and returns clean Markdown.", fields: [apiKey()], setupUrl: "https://www.firecrawl.dev/app/api-keys" },
] as const satisfies readonly WebProviderInfo[];

export type SearchProvider = (typeof SEARCH_PROVIDER_LIST)[number]["id"];
export type FetchProvider = (typeof FETCH_PROVIDER_LIST)[number]["id"];

export const WEB_PROVIDER_LISTS: Record<WebTool, readonly WebProviderInfo[]> = {
  search: SEARCH_PROVIDER_LIST,
  fetch: FETCH_PROVIDER_LIST,
};

export function webProviderInfo(tool: WebTool, id: unknown): WebProviderInfo | undefined {
  return typeof id === "string" ? WEB_PROVIDER_LISTS[tool].find((provider) => provider.id === id) : undefined;
}
export const isSearchProvider = (value: unknown): value is SearchProvider => Boolean(webProviderInfo("search", value));
export const isFetchProvider = (value: unknown): value is FetchProvider => Boolean(webProviderInfo("fetch", value));
export const SEARCH_PROVIDERS = Object.fromEntries(SEARCH_PROVIDER_LIST.map((p) => [p.id, p.name])) as Record<SearchProvider, string>;
export const FETCH_PROVIDERS = Object.fromEntries(FETCH_PROVIDER_LIST.map((p) => [p.id, p.name])) as Record<FetchProvider, string>;

/** Fresh installs read pages with OpenTeam's own fetcher; search stays off until chosen. */
export const DEFAULT_FETCH_PROVIDER: FetchProvider = "builtin";

export interface WebProviderCheck {
  status: "passed" | "failed";
  message: string;
  checkedAt: string;
}

export interface WebProviderState {
  /** Whether the provider's API key is saved. Keys are never returned. */
  secretSaved: boolean;
  /** Everything the provider needs is saved, so it can be selected. */
  ready: boolean;
  /** Last stored connection check; cleared whenever the provider's fields change. */
  check: WebProviderCheck | null;
}

export interface WebToolView<Provider extends string = string> {
  /** null: the tool is off. */
  selected: Provider | null;
  providers: Record<string, WebProviderState>;
}

export interface WebProvidersView {
  search: WebToolView<SearchProvider>;
  fetch: WebToolView<FetchProvider>;
}

export interface WebProviderFieldsInput {
  /** A string saves or replaces the key, null removes it, omitted leaves it unchanged. */
  apiKey?: string | null;
}

export interface WebToolInput {
  selected?: string | null;
  providers?: Record<string, WebProviderFieldsInput>;
}

export interface WebProvidersInput {
  search?: WebToolInput;
  fetch?: WebToolInput;
}

export interface WebProviderCheckInput {
  tool: WebTool;
  provider: string;
}

/** Internal server → computer payloads. */
export interface WebToolCredentials<Provider extends string = string> {
  provider: Provider | null;
  apiKey: string | null;
}

export interface WebProviderCheckRequest {
  tool: WebTool;
  provider: string;
  apiKey: string | null;
}

export interface WebProviderCheckResult {
  ok: boolean;
  message: string;
}

/** Legacy single-tool shapes, kept for clients older than Settings → Providers. */
export interface WebSearchSettingsView {
  provider: string | null;
  hasApiKey: boolean;
  configured: boolean;
}

export interface WebFetchSettingsView {
  provider: string | null;
  hasApiKey: boolean;
  configured: boolean;
}
