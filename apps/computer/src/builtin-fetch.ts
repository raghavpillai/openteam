import { lookup } from "node:dns/promises";
// The explicit entry avoids Bun's incomplete built-in `undici` shim.
import { Client } from "undici/index.js";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { isPublicAddress, publicWebUrl } from "./public-web-url";
import { agentProcessIdentity, sanitizedAgentEnvironment, spawnAgentProcess } from "./agent-process";

/** Raw and decoded body bound. Large enough for long specs and PDFs, small enough for memory. */
export const MAX_WEB_DOWNLOAD = 20 * 1024 * 1024;
const MAX_REDIRECTS = 8;
const HOP_TIMEOUT_MS = 20_000;
const FETCH_DEADLINE_MS = 60_000;

const HONEST_HEADERS = {
  "user-agent": "OpenTeam-WebFetch/1.0",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br",
};
// Some sites only serve complete HTML to browsers. Used only after the honest request is
// blocked or thin, because other sites block clients that claim to be a browser.
const BROWSER_HEADERS = {
  ...HONEST_HEADERS,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

export class WebHttpError extends Error {
  constructor(readonly status: number) {
    super(`Web request failed with HTTP ${status}`);
  }
}

interface RawResponse {
  url: string;
  bytes: Buffer;
  contentType: string;
}

/** Resolve, validate, and pin the socket address on every redirect. No browser state,
 * credentials, proxy environment, scripts or subresources. Cookies set during this one
 * fetch are replayed only to the host that set them, which breaks cookie-check loops. */
export async function publicWebGet(
  value: string,
  signal?: AbortSignal,
  headers: Record<string, string> = HONEST_HEADERS
): Promise<RawResponse> {
  const cookies = new Map<string, Map<string, string>>();
  let target = value;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal?.throwIfAborted();
    const url = publicWebUrl(target);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
      throw new Error("Private and local network destinations are not allowed");
    const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
    const client = new Client(url.origin, {
      maxHeaderSize: 64 * 1024,
      connect: {
        servername: hostname,
        lookup: ((_hostname: string, options: { all?: boolean }, callback: Function) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family)) as never,
      },
    });
    const jar = cookies.get(url.host);
    const timeout = AbortSignal.timeout(HOP_TIMEOUT_MS);
    let status: number, location: string | undefined, contentType: string, encoding: string | undefined;
    let raw: Buffer;
    try {
      const response = await client.request({
        method: "GET",
        path: url.pathname + url.search,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { ...headers, ...(jar?.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}) },
      });
      const header = (name: string) => {
        const entry = response.headers[name];
        return Array.isArray(entry) ? entry : typeof entry === "string" ? [entry] : [];
      };
      for (const line of header("set-cookie")) {
        const pair = line.split(";", 1)[0]!;
        const split = pair.indexOf("=");
        if (split > 0) {
          const store = cookies.get(url.host) ?? new Map<string, string>();
          store.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
          cookies.set(url.host, store);
        }
      }
      status = response.statusCode;
      location = header("location")[0];
      contentType = header("content-type")[0] ?? "";
      encoding = header("content-encoding")[0]?.toLowerCase();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_WEB_DOWNLOAD) throw new Error("Web page exceeds the 20 MiB download limit");
        chunks.push(Buffer.from(chunk));
      }
      raw = Buffer.concat(chunks);
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new Error("The site did not respond within 20 seconds");
      throw error;
    } finally {
      await client.destroy();
    }
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      target = new URL(location, url).href;
      continue;
    }
    if (status < 200 || status >= 300) throw new WebHttpError(status);
    const options = { maxOutputLength: MAX_WEB_DOWNLOAD };
    const bytes =
      encoding === "gzip" || encoding === "x-gzip"
        ? gunzipSync(raw, options)
        : encoding === "deflate"
          ? inflateSync(raw, options)
          : encoding === "br"
            ? brotliDecompressSync(raw, options)
            : raw;
    // Follow an immediate <meta refresh> interstitial like a browser would.
    const refresh = /html/i.test(contentType) && bytes.length < 16_384
      ? /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\s*[0-5]\s*;\s*url=['"]?([^"'>\s]+)/i.exec(bytes.toString("latin1"))
      : null;
    if (refresh?.[1]) {
      target = new URL(refresh[1].replace(/&amp;/g, "&"), url).href;
      continue;
    }
    return { url: url.href, bytes, contentType };
  }
  throw new Error("Too many redirects");
}

const TEXT_TYPES =
  /^(?:text\/[\w.+-]+|application\/(?:[\w.+-]+\+)?(?:json|xml)|application\/(?:javascript|ecmascript|x-ndjson|ndjson|yaml|x-yaml|toml|csv|sql|graphql))\b/i;

/** Sniff when the server omits or misstates the type (common on bot-challenge responses). */
export function kindOf({ bytes, contentType }: RawResponse): "pdf" | "html" | "text" | "binary" {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-" || /application\/pdf/i.test(contentType)) return "pdf";
  const head = bytes.subarray(0, 1024).toString("latin1").trimStart().toLowerCase();
  if (/html/i.test(contentType) || (!contentType && (head.startsWith("<!doctype html") || head.startsWith("<html"))))
    return "html";
  if (TEXT_TYPES.test(contentType)) return "text";
  if (!contentType && bytes.length && !bytes.subarray(0, 1024).includes(0)) return "text";
  return "binary";
}

/** Decode with the declared charset (header, BOM, <meta>, XML declaration), else UTF-8. */
export function decodeWebText(bytes: Buffer, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  if (!charset) {
    const head = bytes.subarray(0, 4096).toString("latin1");
    charset =
      /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
      /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset?.toLowerCase() ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Tables with rows of cells and no nested tables; layout tables are rendered as their content. */
const isDataTable = (table: any) => {
  if (table.querySelector("table")) return false;
  const rows = Array.from(table.querySelectorAll("tr") as ArrayLike<any>);
  return rows.length >= 2 && rows.some((row: any) => row.querySelectorAll("td,th").length >= 2);
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.addRule("dataTable", {
  filter: (node) => node.nodeName === "TABLE" && isDataTable(node),
  replacement: (_content, node: any) => {
    const cell = (element: any) =>
      collapse(turndown.turndown(element.innerHTML ?? "")).replace(/\|/g, "\\|");
    const rows = Array.from(node.querySelectorAll("tr") as ArrayLike<any>)
      .map((row: any) =>
        Array.from((row.childNodes ?? []) as ArrayLike<any>)
          .filter((child: any) => /^(TD|TH)$/i.test(child.nodeName ?? ""))
          .map(cell)
      )
      .filter((row) => row.length);
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width) return "";
    const line = (row: string[]) => `| ${[...row, ...Array(width - row.length).fill("")].join(" | ")} |`;
    const caption = collapse(node.querySelector("caption")?.textContent ?? "");
    return `\n\n${caption ? `**${caption}**\n\n` : ""}${line(rows[0]!)}\n| ${Array(width).fill("---").join(" | ")} |\n${rows.slice(1).map(line).join("\n")}\n\n`;
  },
});
// Images cannot be viewed through WebFetch; keep their description only.
turndown.addRule("image", {
  filter: "img",
  replacement: (_content, node: any) => {
    const alt = collapse(node.getAttribute?.("alt") ?? "");
    return alt ? `[image: ${alt}]` : "";
  },
});

/** Readability and Turndown are synchronous and grow with element count: the WHATWG HTML spec
 * (~331k elements) blocked the computer's event loop for 57s with 3-4 GB RSS on a 4-vCPU
 * cloud VM. Larger pages come back as plain text instead (a 1.9s stall and 610 MB there).
 * The largest ordinary page in the fetch benchmark (RFC 9110) has ~16k elements. */
export const MAX_MARKDOWN_ELEMENTS = 50_000;
const BLOCKS =
  "address,article,aside,blockquote,br,caption,dd,details,div,dl,dt,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,summary,table,tr,ul";

export function webMarkdown(html: string, url: string): string {
  return htmlToText(html, url).text;
}

function htmlToText(html: string, url: string): { text: string; plain: boolean } {
  const { document } = parseHTML(html);
  // Remove active content and form controls (their values can hold prefilled data), but keep
  // form contents: ASP.NET-style pages wrap the whole document in one <form>.
  for (const node of document.querySelectorAll(
    "script,style,noscript,iframe,svg,canvas,template,object,embed,input,select,textarea,button"
  ))
    node.remove();
  if (document.querySelectorAll("*").length > MAX_MARKDOWN_ELEMENTS) {
    for (const node of document.querySelectorAll(BLOCKS)) node.after("\n");
    for (const node of document.querySelectorAll("td,th"))
      if (node.previousElementSibling) node.before(" | ");
    const title = collapse(document.title ?? "");
    const text = (document.body?.textContent ?? "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n\s*/g, (gap: string) => (gap.split("\n").length > 2 ? "\n\n" : "\n"))
      .trim();
    return { text: `${title ? `# ${title}\n\n` : ""}${text}`, plain: true };
  }
  for (const node of document.querySelectorAll("a[href],img[src]")) {
    const key = node.tagName.toLowerCase() === "a" ? "href" : "src";
    node.removeAttribute("title");
    try {
      const target = new URL(node.getAttribute(key)!, url);
      if (["http:", "https:"].includes(target.protocol)) node.setAttribute(key, target.href);
      else node.removeAttribute(key);
    } catch {
      node.removeAttribute(key);
    }
  }
  const title = collapse(document.title ?? "");
  const textLength = () => collapse(document.body?.textContent ?? "").length;
  // Page chrome is dropped from the fallback only when that keeps most of the text; some
  // sites put their main content inside header/footer landmarks.
  const beforeChrome = textLength();
  const chrome = Array.from(
    document.querySelectorAll(
      "nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true]"
    ) as ArrayLike<any>
  );
  const placements = chrome.map((node: any) => [node, node.parentNode, node.nextSibling] as const);
  for (const node of chrome) node.remove();
  if (textLength() < beforeChrome * 0.3)
    for (const [node, parent, next] of placements.reverse()) parent?.insertBefore(node, next);
  const fallback = document.body?.innerHTML ?? "";
  const bodyText = textLength();
  const bodyTables = Array.from(document.querySelectorAll("table") as ArrayLike<any>).filter(isDataTable).length;
  let content = fallback;
  try {
    const article = new Readability(document as unknown as Document).parse();
    const articleText = collapse(article?.textContent ?? "").length;
    const articleTables = (article?.content?.match(/<table/gi) ?? []).length;
    // Readability suits articles but drops listings, pricing cards, data tables and app-like
    // pages. Page chrome is already gone, so use it only when it keeps nearly all the text
    // and any data table (benchmarked: 0.85 kept more facts than 0.5 or 0.7 at ~1% more text).
    if (article?.content && articleText >= bodyText * 0.85 && (bodyTables === 0 || articleTables > 0))
      content = article.content;
  } catch {
    /* Malformed pages still have their inert body. */
  }
  const markdown = turndown
    .turndown(content)
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: `${title ? `# ${title}\n\n` : ""}${markdown}`, plain: false };
}

function pdfText(bytes: Buffer, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Parse untrusted PDFs as the unprivileged agent user, like Read does.
    const child = spawnAgentProcess("pdftotext", ["-enc", "UTF-8", "-", "-"], {
      env: sanitizedAgentEnvironment(process.env),
      ...agentProcessIdentity(),
      stdio: ["pipe", "pipe", "pipe"],
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const stdout: Buffer[] = [];
    let size = 0;
    child.stdin!.on("error", () => {});
    child.stdin!.end(bytes);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_WEB_DOWNLOAD) stdout.push(chunk);
    });
    child.stderr!.resume();
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error("PDF text extraction is unavailable on this computer; download the PDF with Shell and use Read")
          : error
      )
    );
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString("utf8"))
        : reject(new Error("Could not extract text from this PDF; download it with Shell and use Read"))
    );
  });
}

const CHALLENGE =
  /just a moment\.\.\.|checking your browser|enable javascript and cookies|verify you are (a )?human|are you a robot|unusual traffic from your computer|press (&|and) hold|pardon our interruption|access denied|request blocked|captcha/i;

export interface BuiltinPage {
  url: string;
  text: string;
  /** Guidance the agent should see before the content. */
  note?: string;
  retriedWithBrowserHeaders: boolean;
}

type WebGet = typeof publicWebGet;

async function attempt(url: string, headers: Record<string, string>, signal: AbortSignal, get: WebGet) {
  const response = await get(url, signal, headers);
  const kind = kindOf(response);
  if (kind === "binary")
    throw new Error(
      `WebFetch received ${response.contentType.split(";")[0] || "an unknown binary content type"}; download this file with Shell instead`
    );
  if (kind === "pdf") return { url: response.url, text: await pdfText(response.bytes, signal), html: 0, plain: false };
  const decoded = decodeWebText(response.bytes, response.contentType);
  return kind === "html"
    ? { url: response.url, ...htmlToText(decoded, response.url), html: response.bytes.length }
    : { url: response.url, text: decoded, html: 0, plain: false };
}

type Attempt = Awaited<ReturnType<typeof attempt>>;
const bodyOf = (page: Attempt) => page.text.replace(/^# .*\n+/, "");
const challenged = (page: Attempt) => bodyOf(page).length < 3_000 && CHALLENGE.test(page.text);
const thin = (page: Attempt) => page.html > 0 && (collapse(bodyOf(page)).length < 1_500 || challenged(page));
// Some hosts drop a share of connections from cloud IP ranges; undici reports that as
// "Connect Timeout Error", and one more attempt usually connects.
const retryable = (error: unknown) =>
  (error instanceof WebHttpError && [401, 403, 406, 429, 503].includes(error.status)) ||
  /did not respond|other side closed|socket|ECONNRESET|ETIMEDOUT|Connect Timeout|Headers Overflow/i.test(String(error));
const LARGE_PAGE_NOTE = "This page is very large, so it is plain text without links, tables or formatting.";

/** Public pages as Markdown or text. Sends an honest request first and retries once with
 * browser-like headers when a site blocks it or serves a near-empty shell. */
export async function builtinFetch(url: string, signal?: AbortSignal, get: WebGet = publicWebGet): Promise<BuiltinPage> {
  const deadline = AbortSignal.timeout(FETCH_DEADLINE_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let first: Attempt | undefined;
  let firstError: unknown;
  try {
    first = await attempt(url, HONEST_HEADERS, combined, get);
    if (!thin(first))
      return {
        url: first.url,
        text: first.text,
        note: first.plain ? LARGE_PAGE_NOTE : undefined,
        retriedWithBrowserHeaders: false,
      };
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw slow();
    if (!retryable(error)) throw error;
    firstError = error;
  }
  let second: Attempt | undefined;
  try {
    second = await attempt(url, BROWSER_HEADERS, combined, get);
  } catch (error) {
    signal?.throwIfAborted();
    if (!first) throw deadline.aborted ? slow() : blocked(firstError, error);
  }
  const best = second && (!first || collapse(bodyOf(second)).length > collapse(bodyOf(first)).length) ? second : first!;
  const note = challenged(best)
    ? "The site returned a bot check instead of the page. Open it with the browser tool instead."
    : thin(best)
      ? "Little readable text came back; this page probably needs JavaScript. Open it with the browser tool for the full page."
      : best.plain
        ? LARGE_PAGE_NOTE
        : undefined;
  return { url: best.url, text: best.text, note, retriedWithBrowserHeaders: best === second };
}

const slow = () => new Error(`The page did not finish loading within ${FETCH_DEADLINE_MS / 1000} seconds`);

function blocked(first: unknown, second: unknown): Error {
  const error = second instanceof WebHttpError || !(first instanceof WebHttpError) ? second : first;
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    error instanceof WebHttpError && [401, 403, 429].includes(error.status)
      ? `${reason}. The site blocks automated fetching; open it with the browser tool instead`
      : reason
  );
}
