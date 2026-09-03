type BootstrapResponse = {
  channels: Array<{ id: string; name: string }>;
};

type BenchmarkTarget = {
  label: string;
  path: string;
  timingName?: string;
};

const integerSetting = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const baseUrl = (process.env.OPENTEAM_PERF_BASE_URL ?? "http://127.0.0.1:8877").replace(/\/$/, "");
const warmupCount = integerSetting("OPENTEAM_API_WARMUPS", 2);
const sampleCount = Math.max(1, integerSetting("OPENTEAM_API_SAMPLES", 10));

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

const serverDuration = (header: string | null, name: string | undefined) => {
  if (!name) return null;
  const match = header?.match(new RegExp(`(?:^|,)\\s*${name};dur=([0-9.]+)`, "i"));
  return match ? Number.parseFloat(match[1]) : null;
};

const request = async (target: BenchmarkTarget) => {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${target.path}`, { cache: "no-store" });
  const headersAt = performance.now();
  const body = await response.arrayBuffer();
  const bodyAt = performance.now();
  if (!response.ok) {
    throw new Error(
      `${target.path} returned ${response.status}: ${new TextDecoder().decode(body)}`
    );
  }
  let decodeMs = 0;
  if (response.headers.get("content-type")?.includes("json")) {
    const decodeStartedAt = performance.now();
    JSON.parse(new TextDecoder().decode(body));
    decodeMs = performance.now() - decodeStartedAt;
  }
  return {
    bytes: body.byteLength,
    decodeMs,
    downloadMs: bodyAt - headersAt,
    elapsedMs: performance.now() - startedAt,
    serverMs: serverDuration(response.headers.get("server-timing"), target.timingName),
    ttfbMs: headersAt - startedAt,
  };
};

const bootstrapResponse = await fetch(`${baseUrl}/api/v0/client-bootstrap`, {
  cache: "no-store",
});
if (!bootstrapResponse.ok) {
  throw new Error(`/api/v0/client-bootstrap returned ${bootstrapResponse.status}`);
}
const bootstrap = (await bootstrapResponse.json()) as BootstrapResponse;
const transcriptChannel = bootstrap.channels.find((channel) => channel.name === "Audit Bot 0001");
if (!transcriptChannel) throw new Error("The heavy transcript channel Audit Bot 0001 is missing");

const targets: BenchmarkTarget[] = [
  { label: "bootstrap", path: "/api/v0/client-bootstrap", timingName: "bootstrap" },
  { label: "runtime", path: "/api/v0/client-runtime" },
  {
    label: "history-100",
    path: `/api/v0/channels/${encodeURIComponent(transcriptChannel.id)}/history?limit=100`,
  },
  { label: "compatibility-snapshot", path: "/api/v0/client-snapshot", timingName: "snapshot" },
];

const results = [];
for (const target of targets) {
  for (let index = 0; index < warmupCount; index += 1) await request(target);
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) samples.push(await request(target));
  const serverSamples = samples
    .map((sample) => sample.serverMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  results.push({
    ...target,
    bytes: [...new Set(samples.map((sample) => sample.bytes))],
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
    transcriptChannelId: transcriptChannel.id,
    results,
  },
  null,
  2
);
if (process.env.OPENTEAM_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENTEAM_AUDIT_OUTPUT, `${output}\n`);
}
console.log(output);
