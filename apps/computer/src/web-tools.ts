import { describeOutputLocation } from "@openteam/contracts/reference-formatters";
import { SearchProviderClient } from "./search-provider";
import { lookup } from "node:dns/promises";
// The explicit entry avoids Bun's incomplete built-in `undici` shim.
import { Client } from "undici/index.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { publicWebUrl, isPublicAddress } from "./public-web-url";
export { publicWebUrl, isPublicAddress } from "./public-web-url";
import { FetchProviderClient } from "./fetch-provider";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { agentFileIO } from "./agent-file-io";

const MAX_DOWNLOAD = 5 * 1024 * 1024;
export const WEB_INLINE_CHARACTERS = 100_000;

/** Resolve, validate, and pin the socket address on every redirect. No cookies,
 * credentials, proxy environment, browser state, scripts or subresources. */
export async function publicWebGet(
  value: string,
  signal?: AbortSignal,
  redirects = 0
): Promise<{ url: string; bytes: Buffer; contentType: string }> {
  signal?.throwIfAborted();
  if (redirects > 5) throw new Error("Too many redirects");
  const url = publicWebUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new Error("Private and local network destinations are not allowed");
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  const timeout = AbortSignal.timeout(30_000);
  const client = new Client(url.origin, {
    connect: {
      servername: hostname,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: Function) =>
        options.all
          ? callback(null, [address])
          : callback(null, address.address, address.family)) as never,
    },
  });
  let result: {
    status: number;
    location?: string;
    bytes: Buffer;
    contentType: string;
    encoding?: string;
  };
  try {
    const response = await client.request({
      method: "GET",
      path: url.pathname + url.search,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        "user-agent": "OpenTeam-WebFetch/1.0",
        accept: "text/html, text/plain, application/json, text/markdown, */*;q=0.1",
        "accept-encoding": "identity",
      },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD) throw new Error("Web page exceeds the 5 MiB download limit");
      chunks.push(Buffer.from(chunk));
    }
    const header = (name: string) =>
      typeof response.headers[name] === "string" ? (response.headers[name] as string) : undefined;
    result = {
      status: response.statusCode,
      location: header("location"),
      bytes: Buffer.concat(chunks),
      contentType: header("content-type") ?? "",
      encoding: header("content-encoding"),
    };
  } finally {
    await client.destroy();
  }
  if ([301, 302, 303, 307, 308].includes(result.status) && result.location)
    return publicWebGet(new URL(result.location, url).href, signal, redirects + 1);
  if (result.status < 200 || result.status >= 300)
    throw new Error(`Web request failed with HTTP ${result.status}`);
  const options = { maxOutputLength: MAX_DOWNLOAD };
  const bytes =
    result.encoding === "gzip"
      ? gunzipSync(result.bytes, options)
      : result.encoding === "deflate"
        ? inflateSync(result.bytes, options)
        : result.encoding === "br"
          ? brotliDecompressSync(result.bytes, options)
          : result.bytes;
  return { url: url.href, bytes, contentType: result.contentType };
}

export function webMarkdown(html: string, url: string): string {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style,noscript,iframe,svg,form"))
    node.remove();
  for (const node of document.querySelectorAll("a[href],img[src]")) {
    const key = node.tagName.toLowerCase() === "a" ? "href" : "src";
    try {
      const target = new URL(node.getAttribute(key)!, url);
      if (["http:", "https:"].includes(target.protocol)) node.setAttribute(key, target.href);
      else node.removeAttribute(key);
    } catch {
      node.removeAttribute(key);
    }
  }
  const title = document.title;
  const fallback = document.body.innerHTML;
  let content = fallback;
  try {
    content = new Readability(document as unknown as Document).parse()?.content ?? fallback;
  } catch {
    /* Malformed pages still have their inert body. */
  }
  const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
    .turndown(content)
    .trim();
  return `${title ? `# ${title}\n\n` : ""}${markdown}`;
}

export class WebTools {
  constructor(
    private readonly searchProvider = new SearchProviderClient(),
    private readonly fetchProvider = new FetchProviderClient()
  ) {}

  async fetch(url: string, cwd: string, signal?: AbortSignal) {
    try { return await this.fetchContent(url, cwd, signal); }
    catch (error) { if (signal?.aborted) throw error; return { content: [{ type: "text" as const, text: `Error fetching URL ${url}: ${error instanceof Error ? error.message : String(error)}` }], details: { url, error: true, configured: undefined } }; }
  }
  private async fetchContent(url: string, cwd: string, signal?: AbortSignal) {
    const provided = await this.fetchProvider.fetch(url, signal);
    if (!provided.configured)
      return {
        content: [{ type: "text" as const, text: provided.message }],
        details: { configured: false, provider: provided.provider, url },
      };
    let content: string;
    let resultUrl: string;
    if (provided.provider === "builtin") {
      const result = await publicWebGet(url, signal);
      if (!/^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(result.contentType))
        throw new Error(
          `WebFetch received ${result.contentType || "an unknown binary content type"}; download this file with Shell instead`
        );
      content = /html/i.test(result.contentType)
        ? webMarkdown(result.bytes.toString("utf8"), result.url)
        : result.bytes.toString("utf8");
      resultUrl = result.url;
    } else {
      content = provided.text;
      resultUrl = provided.url;
    }
    let text = `# Content from ${resultUrl}\n\n${content}`;
    let outputPath: string | undefined;
    if (text.length > WEB_INLINE_CHARACTERS) {
      outputPath = resolve(cwd, ".openteam", "web", `${randomUUID()}.md`);
      await agentFileIO("write", outputPath, signal, Buffer.from(text));
      text = describeOutputLocation({ filePath: outputPath, sizeBytes: Buffer.byteLength(text), lineCount: text.split("\n").length }, {});
    }
    return {
      content: [{ type: "text" as const, text }],
      details: {
        configured: true,
        provider: provided.provider,
        url: resultUrl,
        outputPath,
        characters: content.length,
      },
    };
  }

  async search(searchTerm: string, signal?: AbortSignal) {
    try { return await this.searchProvider.search(searchTerm, signal); }
    catch (error) { if (signal?.aborted) throw error; return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true } }; }
  }
}
