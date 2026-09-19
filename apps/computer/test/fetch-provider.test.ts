import { expect, test } from "bun:test";
import { FetchProviderClient } from "../src/fetch-provider";
import { publicWebUrl } from "../src/public-web-url";
import { WebTools } from "../src/web-tools";
import { SearchProviderClient } from "../src/search-provider";
import { serverFetchConfiguration } from "../src/search-settings";
const url = "https://example.com/page",
  key = "synthetic-fetch-key";
const validate = async (value: string) => publicWebUrl(value);
for (const provider of ["exa", "tavily"] as const) {
  test(`${provider} uses the documented extraction API and returns source content`, async () => {
    const client = new FetchProviderClient(
      () => ({ provider, apiKey: key }),
      async (endpoint, init) => {
        expect(endpoint).toBe(
          provider === "exa" ? "https://api.exa.ai/contents" : "https://api.tavily.com/extract"
        );
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(
          new Headers(init.headers).get(provider === "exa" ? "x-api-key" : "authorization")
        ).toBe(provider === "exa" ? key : `Bearer ${key}`);
        expect(JSON.parse(String(init.body))).toEqual(
          provider === "exa"
            ? { ids: [url], text: true, maxAgeHours: 0, livecrawlTimeout: 15000 }
            : {
                urls: [url],
                extract_depth: "advanced",
                format: "markdown",
                include_images: false,
                timeout: 20,
              }
        );
        return Response.json({
          results: [{ url, text: "# Page\n" + key, raw_content: "# Page\n" + key }],
          statuses: [{ id: url, status: "success" }],
          failed_results: [],
        });
      },
      validate
    );
    const web = new WebTools(new SearchProviderClient(), client);
    const result = await web.fetch(url, process.cwd());
    expect(result.details).toMatchObject({ configured: true, provider, url });
    expect(result.content[0]!.text).toContain("# Page");
    expect(JSON.stringify(result)).not.toContain(key);
  });
  test(`${provider} rejects failed extraction even with HTTP 200`, async () => {
    for (const body of [
      { results: [], statuses: [{ id: url, status: "error" }], failed_results: [{ url }] },
      {
        results: [{ url, text: "partial", raw_content: "partial" }],
        statuses: [{ id: url, status: "error" }],
        failed_results: [{ url }],
      },
      { results: [{ url, text: "", raw_content: "" }] },
      { results: [{ url: "http://127.0.0.1", text: "private", raw_content: "private" }] },
      { error: key },
    ]) {
      const client = new FetchProviderClient(
        () => ({ provider, apiKey: key }),
        async () => Response.json(body),
        validate
      );
      await expect(client.fetch(url)).rejects.toThrow("could not extract");
    }
  });
}
test("missing fetch configuration makes no request; built-in requires explicit selection", async () => {
  let requests = 0;
  const request = async () => {
    requests++;
    throw new Error("unexpected request");
  };
  const missing = await new FetchProviderClient(undefined, request).fetch(url);
  expect(missing).toMatchObject({ configured: false, provider: null });
  expect("message" in missing && missing.message).toContain("No fetch configured");
  expect(
    await new FetchProviderClient(() => ({ provider: "builtin" }), request).fetch(url)
  ).toEqual({
    configured: true,
    provider: "builtin",
  });
  for (const provider of ["exa", "tavily"] as const) {
    const result = await new WebTools(
      new SearchProviderClient(),
      new FetchProviderClient(() => ({ provider }), request)
    ).fetch(url, process.cwd());
    expect(result.details.configured).toBe(false);
    expect(result.content[0]!.text).toContain("No page was fetched");
  }
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
    () => ({ provider: "tavily", apiKey: key }),
    async () => new Response("x".repeat(5 * 1024 * 1024 + 1)),
    validate
  );
  await expect(oversized.fetch(url)).rejects.toThrow("could not extract");
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
  expect(await configuration()).toEqual({ provider: undefined, apiKey: undefined });
  value = { provider: "builtin", apiKey: null };
  expect(await configuration()).toEqual({ provider: "builtin", apiKey: undefined });
  value = { provider: "exa", apiKey: key };
  expect(await configuration()).toEqual({ provider: "exa", apiKey: key });
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
