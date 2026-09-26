import { expect, test } from "bun:test";
import type { FetchProvider } from "@openteam/contracts/web-search";
import { FetchProviderClient } from "../src/fetch-provider";
import { publicWebUrl } from "../src/public-web-url";
import { WebTools } from "../src/web-tools";
import { SearchProviderClient } from "../src/search-provider";
import { serverFetchConfiguration } from "../src/search-settings";
const url = "https://example.com/page",
  key = "synthetic-fetch-key";
const validate = async (value: string) => publicWebUrl(value);
type Case = {
  endpoint: string;
  auth: [string, string];
  body: unknown;
  success: () => Response;
  pageFailure: () => Response;
  finalUrl: string;
};
const finalUrl = "https://example.com/final";
// Response shapes follow each provider's documented examples (2026-09).
const CASES: Record<Exclude<FetchProvider, "builtin">, Case> = {
  firecrawl: {
    endpoint: "https://api.firecrawl.dev/v2/scrape",
    auth: ["authorization", `Bearer ${key}`],
    body: { url, formats: ["markdown"], onlyMainContent: true, maxAge: 0, timeout: 45_000, parsers: [{ type: "pdf", maxPages: 25 }] },
    success: () => Response.json({ success: true, data: { markdown: "# Page\n" + key, metadata: { sourceURL: url, url: finalUrl, statusCode: 200 } } }),
    pageFailure: () => Response.json({ success: true, data: { markdown: "Not found", metadata: { url, statusCode: 404 } } }),
    finalUrl,
  },
  exa: {
    endpoint: "https://api.exa.ai/contents",
    auth: ["x-api-key", key],
    body: { urls: [url], text: true, maxAgeHours: 1, livecrawlTimeout: 15_000 },
    success: () => Response.json({ results: [{ url: finalUrl, text: "# Page\n" + key }], statuses: [{ id: url, status: "success", source: "crawled" }] }),
    pageFailure: () => Response.json({ results: [], statuses: [{ id: url, status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } }] }),
    finalUrl,
  },
  parallel: {
    endpoint: "https://api.parallel.ai/v1/extract",
    auth: ["x-api-key", key],
    body: { urls: [url], advanced_settings: { full_content: true, fetch_policy: { max_age_seconds: 600, timeout_seconds: 30 } } },
    success: () => Response.json({ extract_id: "x", results: [{ url: finalUrl, title: "Page", full_content: "# Page\n" + key, excerpts: [] }], errors: [] }),
    pageFailure: () => Response.json({ extract_id: "x", results: [], errors: [{ url, error_type: "fetch_error", http_status_code: 500, content: "Error fetching content" }] }),
    finalUrl,
  },
};

for (const [provider, spec] of Object.entries(CASES)) {
  const client = (respond: () => Response, apiKey: string | undefined = key) =>
    new FetchProviderClient(
      () => ({ provider: provider as FetchProvider, apiKey }),
      async (endpoint, init) => {
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(endpoint).toBe(spec.endpoint);
        expect(new Headers(init.headers).get(spec.auth[0])).toBe(spec.auth[1]);
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual(spec.body);
        return respond();
      },
      validate
    );
  test(`${provider} uses its documented endpoint, auth and body and returns redacted content`, async () => {
    const result = await client(spec.success).fetch(url);
    expect(result).toMatchObject({ configured: true, provider, url: spec.finalUrl });
    expect("text" in result && result.text).toStartWith("# Page");
    expect(JSON.stringify(result)).not.toContain(key);
    const web = await new WebTools(new SearchProviderClient(), client(spec.success)).fetch(url, process.cwd());
    expect(web.content[0]!.text).toContain("# Page");
  });
  test(`${provider} reports page failures inside a successful response`, async () => {
    await expect(client(spec.pageFailure).fetch(url)).rejects.toThrow(/Try another URL, or open the page with the browser tool/);
  });
  test(`${provider} explains request-level errors without echoing the key`, async () => {
    for (const [status, hint] of [[401, "Check the API key"], [402, "quota"], [429, "rate limit"], [422, "couldn't read this page"], [500, "Retry later"]] as const) {
      const error = await client(() => Response.json({ error: { message: `bad ${key}` } }, { status })).fetch(url).then(() => null, (e: Error) => e);
      expect(error?.message).toContain(`HTTP ${status}`);
      expect(error?.message).toContain(hint);
      expect(error?.message).not.toContain(key);
    }
  });
}

test("Firecrawl notes truncated PDFs and reports sites it declines as refusals, not key problems", async () => {
  const firecrawl = (respond: () => Response) =>
    new FetchProviderClient(() => ({ provider: "firecrawl", apiKey: key }), async () => respond(), validate);
  const pdf = (numPages: number, totalPages: number) => () =>
    Response.json({ success: true, data: { markdown: "RFC text", metadata: { url, statusCode: 200, numPages, totalPages } } });
  expect(await firecrawl(pdf(25, 194)).fetch(url)).toMatchObject({
    note: "Firecrawl read only the first 25 of 194 PDF pages. Download the PDF with Shell and use Read for the rest.",
  });
  expect(await firecrawl(pdf(5, 5)).fetch(url)).not.toHaveProperty("note");
  const web = await new WebTools(new SearchProviderClient(), firecrawl(pdf(25, 194))).fetch(url, process.cwd());
  expect(web.content[0]!.text).toContain("Note: Firecrawl read only the first 25 of 194 PDF pages.");

  const declined = () =>
    Response.json({ success: false, error: "We apologize for the inconvenience but we do not support this site. If you are part of an enterprise, contact us." }, { status: 403 });
  const refusal = await firecrawl(declined).fetch(url).then(() => null, (e: Error) => e);
  expect(refusal?.message).toBe("Firecrawl doesn't fetch this site. Open the page with the browser tool instead.");
  const forbidden = await firecrawl(() => Response.json({ success: false, error: "Forbidden" }, { status: 403 })).fetch(url).then(() => null, (e: Error) => e);
  expect(forbidden?.message).toContain("Check the API key");
});

test("every third-party fetch provider needs its key; nothing is sent without one", async () => {
  for (const provider of Object.keys(CASES) as FetchProvider[]) {
    const result = await new FetchProviderClient(() => ({ provider }), async () => {
      throw new Error("must not call network");
    }).fetch(url);
    expect(result).toMatchObject({ configured: false, provider });
    expect("message" in result && result.message).toContain("is selected but its API key is missing");
  }
});

test("fetch defaults to built-in, can be turned off, and never sends a request without a key", async () => {
  let requests = 0;
  const request = async () => {
    requests++;
    throw new Error("unexpected request");
  };
  expect(await new FetchProviderClient(undefined, request).fetch(url)).toEqual({
    configured: true,
    provider: "builtin",
  });
  expect(await new FetchProviderClient(() => ({ provider: "builtin" }), request).fetch(url)).toEqual({
    configured: true,
    provider: "builtin",
  });
  const off = await new FetchProviderClient(() => ({ provider: null }), request).fetch(url);
  expect(off).toMatchObject({ configured: false, provider: null });
  expect("message" in off && off.message).toContain("Web fetch is turned off");
  for (const provider of ["exa", "parallel", "firecrawl"] as const) {
    const result = new WebTools(
      new SearchProviderClient(),
      new FetchProviderClient(() => ({ provider }), request)
    ).fetch(url, process.cwd());
    await expect(result).rejects.toThrow("is selected but its API key is missing. No page was fetched");
  }
  await expect(
    new WebTools(new SearchProviderClient(), new FetchProviderClient(() => ({ provider: null }), request)).fetch(url, process.cwd())
  ).rejects.toThrow("Web fetch is turned off");
  expect(requests).toBe(0);
});
test("external fetch sanitizes failures and honors cancellation and response bounds", async () => {
  for (const status of [401, 403, 429, 500]) {
    const client = new FetchProviderClient(
      () => ({ provider: "exa", apiKey: key }),
      async () => new Response(key, { status }),
      validate
    );
    await expect(client.fetch(url)).rejects.toThrow(`HTTP ${status}`);
  }
  const failed = new FetchProviderClient(
    () => ({ provider: "exa", apiKey: key }),
    async () => {
      throw new Error(key);
    },
    validate
  );
  try {
    await failed.fetch(url);
  } catch (error) {
    expect(String(error)).not.toContain(key);
  }
  const oversized = new FetchProviderClient(
    () => ({ provider: "parallel", apiKey: key }),
    async () => new Response("x".repeat(5 * 1024 * 1024 + 1)),
    validate
  );
  await expect(oversized.fetch(url)).rejects.toThrow("returned an invalid response");
  const abort = new AbortController();
  abort.abort();
  await expect(failed.fetch(url, abort.signal)).rejects.toThrow();
  for (const invalid of [
    "http://localhost",
    "http://169.254.169.254",
    "https://user:pw@example.com",
    "file:///tmp/private",
  ])
    await expect(failed.fetch(invalid)).rejects.toThrow();
});
test("runtime fetch configuration defaults from server and observes provider changes", async () => {
  let value = { provider: null as string | null, apiKey: null as string | null };
  let reads = 0;
  const configuration = serverFetchConfiguration(
    "http://server",
    "test-control",
    async (input, init) => {
      expect(input).toBe("http://server/api/internal/server-settings/web-fetch/credentials");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-control");
      reads++;
      return Response.json(value);
    }
  );
  expect(await configuration()).toEqual({ provider: null, apiKey: undefined });
  value = { provider: "builtin", apiKey: null };
  expect(await configuration()).toEqual({ provider: "builtin", apiKey: undefined });
  value = { provider: "firecrawl", apiKey: key };
  expect(await configuration()).toEqual({ provider: "firecrawl", apiKey: key });
  expect(reads).toBe(3);
  value = { provider: "brave", apiKey: key };
  await expect(configuration()).rejects.toThrow("settings could not be loaded");
});

test("oversized extraction spills redacted full content to an actual file", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "web-fetch-spill-"));
  try {
    const client = new FetchProviderClient(
      () => ({ provider: "exa", apiKey: key }),
      async () =>
        Response.json({
          results: [{ url, text: "Start\n" + "text ".repeat(25000) + key + "\nEnd" }],
        }),
      validate
    );
    const result = await new WebTools(new SearchProviderClient(), client).fetch(url, cwd);
    expect(result.content[0]!.text).toContain("Content written to file:");
    const outputPath = "outputPath" in result.details ? result.details.outputPath : undefined;
    expect(outputPath).toBeDefined();
    const full = await readFile(outputPath!, "utf8");
    expect(full).toContain("End");
    expect(full).toContain("[redacted]");
    expect(full).not.toContain(key);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
