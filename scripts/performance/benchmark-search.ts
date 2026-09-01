type SearchCategory = "all" | "messages" | "bots" | "channels" | "files" | "links" | "routines";

type SearchResponse = {
  query: string;
  results: Array<{ kind: string }>;
};

type SearchCase = {
  category: SearchCategory;
  query: string;
  expectedKind?: string;
};

const cases: SearchCase[] = [
  { category: "all", query: "performance" },
  { category: "messages", query: "synthetic", expectedKind: "message" },
  { category: "bots", query: "Audit Bot", expectedKind: "bot" },
  { category: "channels", query: "Audit Group", expectedKind: "channel" },
  { category: "files", query: "audit-report", expectedKind: "file" },
  { category: "links", query: "openbot", expectedKind: "link" },
  { category: "routines", query: "Audit Routine", expectedKind: "routine" },
  { category: "all", query: "definitely-missing-openbot-term" },
];

const integerSetting = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const baseUrl = (process.env.OPENBOT_PERF_BASE_URL ?? "http://127.0.0.1:8877").replace(/\/$/, "");
const warmupCount = integerSetting("OPENBOT_SEARCH_WARMUPS", 3);
const sampleCount = Math.max(1, integerSetting("OPENBOT_SEARCH_SAMPLES", 20));

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
};

const summarize = (values: number[]) => ({
  min: Math.min(...values),
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
  mean: values.reduce((total, value) => total + value, 0) / values.length,
});

const serverDuration = (header: string | null) => {
  const match = header?.match(/(?:^|,)\s*search;dur=([0-9.]+)/i);
  return match ? Number.parseFloat(match[1]) : null;
};

const request = async (entry: SearchCase) => {
  const url = new URL("/api/v0/search", baseUrl);
  url.searchParams.set("q", entry.query);
  url.searchParams.set("category", entry.category);

  const startedAt = performance.now();
  const response = await fetch(url, { cache: "no-store" });
  const headersAt = performance.now();
  if (!response.ok) {
    throw new Error(
      `${url.pathname}${url.search} returned ${response.status}: ${await response.text()}`
    );
  }

  const text = await response.text();
  const bodyAt = performance.now();
  const body = JSON.parse(text) as SearchResponse;
  const decodedAt = performance.now();
  if (!Array.isArray(body.results)) {
    throw new Error(`${url.pathname}${url.search} returned an invalid search response`);
  }
  if (entry.expectedKind && !body.results.some((result) => result.kind === entry.expectedKind)) {
    throw new Error(
      `${url.pathname}${url.search} did not return an expected ${entry.expectedKind} result`
    );
  }

  return {
    bytes: new TextEncoder().encode(text).byteLength,
    decodeMs: decodedAt - bodyAt,
    downloadMs: bodyAt - headersAt,
    elapsedMs: decodedAt - startedAt,
    resultCount: body.results.length,
    serverMs: serverDuration(response.headers.get("server-timing")),
    ttfbMs: headersAt - startedAt,
  };
};

const results = [];
for (const entry of cases) {
  for (let index = 0; index < warmupCount; index += 1) await request(entry);

  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) samples.push(await request(entry));
  const serverSamples = samples
    .map((sample) => sample.serverMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  results.push({
    ...entry,
    bytes: [...new Set(samples.map((sample) => sample.bytes))],
    resultCount: samples.at(-1)?.resultCount ?? 0,
    ttfbMs: summarize(samples.map((sample) => sample.ttfbMs)),
    downloadMs: summarize(samples.map((sample) => sample.downloadMs)),
    decodeMs: summarize(samples.map((sample) => sample.decodeMs)),
    endToEndMs: summarize(samples.map((sample) => sample.elapsedMs)),
    serverMs: serverSamples.length === samples.length ? summarize(serverSamples) : null,
  });
}

const output = JSON.stringify(
  {
    baseUrl,
    measuredAt: new Date().toISOString(),
    sampleCount,
    warmupCount,
    results,
  },
  null,
  2
);
if (process.env.OPENBOT_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENBOT_AUDIT_OUTPUT, `${output}\n`);
}
console.log(output);
