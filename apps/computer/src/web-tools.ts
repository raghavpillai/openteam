import { SearchProviderClient } from "./search-provider";
export { publicWebUrl, isPublicAddress } from "./public-web-url";
export { publicWebGet, webMarkdown } from "./builtin-fetch";
import { builtinFetch } from "./builtin-fetch";
import { FetchProviderClient } from "./fetch-provider";

export const WEB_INLINE_CHARACTERS = 100_000;

/** The reference's inline cut: the first characters, then how many lines were left out. */
export const truncateWebContent = (content: string, maxSize = WEB_INLINE_CHARACTERS): string => {
  if (content.length <= maxSize) return content;
  let linesTruncated = 1;
  for (let index = content.indexOf("\n", maxSize); index !== -1; index = content.indexOf("\n", index + 1)) linesTruncated++;
  return `${content.slice(0, maxSize)}\n\n...[${linesTruncated} line${linesTruncated === 1 ? "" : "s"} truncated]`;
};

export class WebTools {
  constructor(
    private readonly searchProvider = new SearchProviderClient(),
    private readonly fetchProvider = new FetchProviderClient()
  ) {}

  async fetch(url: string, signal?: AbortSignal) {
    try { return await this.fetchContent(url, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      // Throw so the agent runtime and persisted trace classify this as a failed tool call,
      // rather than a successful fetch with no page content.
      throw new Error(`Error fetching URL ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async fetchContent(url: string, signal?: AbortSignal) {
    const provided = await this.fetchProvider.fetch(url, signal);
    if (!provided.configured) throw new Error(provided.message);
    let content: string;
    let resultUrl: string;
    let note: string | undefined;
    let source: "cached" | "crawled" | "unknown" = "crawled";
    let retriedWithBrowserHeaders = false;
    if (provided.provider === "builtin") {
      const page = await builtinFetch(url, signal);
      ({ text: content, url: resultUrl, note, retriedWithBrowserHeaders } = page);
    } else {
      ({ text: content, url: resultUrl, note } = provided);
      source = provided.provenance.source;
    }
    // The reference heads the page with the URL it was asked for, not the one redirects ended on.
    const header = `# Content from ${url}\n\n`;
    // Like the reference, a long page is cut inline at 100,000 characters; nothing is written to disk.
    return {
      content: [{ type: "text" as const, text: header + truncateWebContent(content) }],
      details: {
        configured: true,
        provider: provided.provider,
        url: resultUrl,
        requestedUrl: url,
        source,
        characters: content.length,
        ...(note ? { note } : {}),
        ...(retriedWithBrowserHeaders ? { retriedWithBrowserHeaders } : {}),
      },
    };
  }

  async search(searchTerm: string, signal?: AbortSignal) {
    try { return await this.searchProvider.search(searchTerm, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      // Failed and unconfigured searches are failed tool calls, never empty successes.
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }
}
