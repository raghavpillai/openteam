import { describeOutputLocation } from "@openteam/contracts/reference-formatters";
import { SearchProviderClient } from "./search-provider";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
export { publicWebUrl, isPublicAddress } from "./public-web-url";
export { publicWebGet, webMarkdown } from "./builtin-fetch";
import { builtinFetch } from "./builtin-fetch";
import { FetchProviderClient } from "./fetch-provider";
import { agentFileIO } from "./agent-file-io";

export const WEB_INLINE_CHARACTERS = 100_000;

export class WebTools {
  constructor(
    private readonly searchProvider = new SearchProviderClient(),
    private readonly fetchProvider = new FetchProviderClient()
  ) {}

  async fetch(url: string, cwd: string, signal?: AbortSignal) {
    try { return await this.fetchContent(url, cwd, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      // Throw so the agent runtime and persisted trace classify this as a failed tool call,
      // rather than a successful fetch with no page content.
      throw new Error(`Error fetching URL ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async fetchContent(url: string, cwd: string, signal?: AbortSignal) {
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
    const retrievedAt = new Date().toISOString();
    const provenance = `Retrieval: ${provided.provider}; source: ${source}; retrieved at: ${retrievedAt}.`;
    const freshness = source === "cached"
      ? "Cached content; crawl time is unavailable. This does not verify current prices, availability or shipping. Use the browser to verify time-sensitive facts in the requested region."
      : source === "unknown"
        ? "The provider did not report whether this content was cached or freshly crawled."
        : "Fetched during this request; page content can still be stale or location-dependent.";
    const header = `# Content from ${resultUrl}\n\n${provenance} ${freshness}\n\n${note ? `Note: ${note}\n\n` : ""}`;
    let text = header + content;
    let outputPath: string | undefined;
    if (text.length > WEB_INLINE_CHARACTERS) {
      outputPath = resolve(cwd, ".openteam", "web", `${randomUUID()}.md`);
      await agentFileIO("write", outputPath, signal, Buffer.from(text));
      text = header + describeOutputLocation({ filePath: outputPath, sizeBytes: Buffer.byteLength(text), lineCount: text.split("\n").length }, {});
    }
    return {
      content: [{ type: "text" as const, text }],
      details: {
        configured: true,
        provider: provided.provider,
        url: resultUrl,
        requestedUrl: url,
        source,
        retrievedAt,
        outputPath,
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
