import { createHash } from "node:crypto";
import type {
  ChannelHistoryPage,
  ChannelMessageContextView,
} from "../../packages/contracts/src/index";
import {
  mergeLoadedChannelHistoryPage,
  mergeLoadedChannelMessageContext,
} from "../../packages/product-core/src/history";

type BootstrapResponse = {
  channels: Array<{ id: string; name: string }>;
};

type Metric = {
  bytes: number;
  decodeMs: number;
  endToEndMs: number;
  ttfbMs: number;
};

const integerSetting = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const baseUrl = (process.env.OPENBOT_PERF_BASE_URL ?? "http://127.0.0.1:8877").replace(/\/$/, "");
const warmupCount = integerSetting("OPENBOT_PAGINATION_WARMUPS", 3);
const sampleCount = Math.max(1, integerSetting("OPENBOT_PAGINATION_SAMPLES", 20));
const depthTargets = [0, 100, 1_000, 5_000, 9_900, 10_000] as const;
const utf8 = new TextEncoder();

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

const summarize = (values: number[]) => ({
  min: Math.min(...values),
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
  mean: values.reduce((total, value) => total + value, 0) / values.length,
});

const requestJson = async <Value>(path: string): Promise<{ metric: Metric; value: Value }> => {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
  const headersAt = performance.now();
  const body = await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${new TextDecoder().decode(body)}`);
  }
  const decodeStartedAt = performance.now();
  const value = JSON.parse(new TextDecoder().decode(body)) as Value;
  const finishedAt = performance.now();
  return {
    metric: {
      bytes: body.byteLength,
      decodeMs: finishedAt - decodeStartedAt,
      endToEndMs: finishedAt - startedAt,
      ttfbMs: headersAt - startedAt,
    },
    value,
  };
};

const benchmark = async <Value>(path: string) => {
  for (let index = 0; index < warmupCount; index += 1) await requestJson<Value>(path);
  const samples: Metric[] = [];
  let representative!: Value;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = await requestJson<Value>(path);
    representative = sample.value;
    samples.push(sample.metric);
  }
  return {
    bytes: [...new Set(samples.map((sample) => sample.bytes))],
    decodeMs: summarize(samples.map((sample) => sample.decodeMs)),
    endToEndMs: summarize(samples.map((sample) => sample.endToEndMs)),
    representative,
    ttfbMs: summarize(samples.map((sample) => sample.ttfbMs)),
  };
};

const historyPath = (channelId: string, limit: number, beforeSequence: string | null = null) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (beforeSequence) params.set("before", beforeSequence);
  return `/api/v0/channels/${encodeURIComponent(channelId)}/history?${params}`;
};

const contextPath = (messageId: string, before: number, after: number) =>
  `/api/v0/channel-messages/${encodeURIComponent(messageId)}/context?before=${before}&after=${after}`;

const fixtureUuid = (value: string) => {
  const hex = createHash("md5").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const timing = (result: Awaited<ReturnType<typeof benchmark>>) => ({
  decodeMs: result.decodeMs,
  endToEndMs: result.endToEndMs,
  ttfbMs: result.ttfbMs,
});

const contentBytes = (page: {
  messages: ChannelHistoryPage["messages"];
  threadContext?: ChannelHistoryPage["threadContext"];
}) =>
  [...page.messages, ...(page.threadContext ?? [])].reduce(
    (total, message) => total + utf8.encode(message.content).byteLength,
    0
  );

const bootstrap = (await requestJson<BootstrapResponse>("/api/v0/client-bootstrap")).value;
const transcript = bootstrap.channels.find((channel) => channel.name === "Audit Bot 0001");
const stress = bootstrap.channels.find((channel) => channel.name === "iOS Stress Fixture");
if (!transcript) throw new Error("Audit Bot 0001 is missing; seed the long transcript fixture");
if (!stress) throw new Error("iOS Stress Fixture is missing; seed ios_stress_fixture=true");

const locations = new Map<
  number,
  { beforeSequence: string | null; page: ChannelHistoryPage; path: string }
>();
let depth = 0;
let cursor: string | null = null;
let transcriptMessagesDiscovered = 0;
const fullHistoryTraversal = {
  decodeMs: 0,
  endToEndMs: 0,
  messages: 0,
  requests: 0,
  responseBytes: 0,
  ttfbMs: 0,
};
while (depth <= Math.max(...depthTargets)) {
  const path = historyPath(transcript.id, 100, cursor);
  const traversalPage = await requestJson<ChannelHistoryPage>(path);
  const page = traversalPage.value;
  fullHistoryTraversal.decodeMs += traversalPage.metric.decodeMs;
  fullHistoryTraversal.endToEndMs += traversalPage.metric.endToEndMs;
  fullHistoryTraversal.messages += page.messages.length;
  fullHistoryTraversal.requests += 1;
  fullHistoryTraversal.responseBytes += traversalPage.metric.bytes;
  fullHistoryTraversal.ttfbMs += traversalPage.metric.ttfbMs;
  transcriptMessagesDiscovered = depth + page.messages.length;
  if ((depthTargets as readonly number[]).includes(depth)) {
    locations.set(depth, { beforeSequence: cursor, page, path });
  }
  if (!page.hasMore || !page.beforeSequence || page.messages.length === 0) break;
  cursor = page.beforeSequence;
  depth += page.messages.length;
}

const pageDepth = [];
for (const requestedDepth of depthTargets) {
  const location = locations.get(requestedDepth);
  if (!location) continue;
  const result = await benchmark<ChannelHistoryPage>(location.path);
  pageDepth.push({
    beforeSequence: location.beforeSequence,
    contentBytes: contentBytes(result.representative),
    depth: requestedDepth,
    hasMore: result.representative.hasMore,
    messages: result.representative.messages.length,
    responseBytes: result.bytes,
    threadContext: result.representative.threadContext.length,
    timing: timing(result),
  });
}

const pageSize = [];
for (const limit of [20, 50, 100, 200]) {
  const result = await benchmark<ChannelHistoryPage>(historyPath(transcript.id, limit));
  pageSize.push({
    contentBytes: contentBytes(result.representative),
    limit,
    messages: result.representative.messages.length,
    responseBytes: result.bytes,
    timing: timing(result),
  });
}

const plainMessage = locations.get(0)?.page.messages.at(-1);
if (!plainMessage) throw new Error("The transcript fixture has no messages");
const largeMessageId = "41405e10-038d-d015-dee7-e78c0edc44f0";
const deepLeafId = "167e7433-da36-c7c4-45bb-6d9e49e0eb7b";
const wideReplyId = fixtureUuid("perf-ios-wide-thread-reply-250");
const largeProbe = (await requestJson<ChannelMessageContextView>(contextPath(largeMessageId, 0, 0)))
  .value;
const largeSequence = largeProbe.messages.find(
  (message) => message.id === largeMessageId
)?.sequence;
if (!largeSequence) throw new Error("The 200 KB fixture message is missing");

const contextTargets = [
  { after: 0, before: 0, label: "plain-single", messageId: plainMessage.id },
  { after: 0, before: 0, label: "wide-thread-leaf", messageId: wideReplyId },
  { after: 0, before: 0, label: "deep-thread-leaf", messageId: deepLeafId },
  { after: 0, before: 0, label: "large-200kb-single", messageId: largeMessageId },
  { after: 50, before: 50, label: "large-200kb-around-50", messageId: largeMessageId },
] as const;

const messageContext = [];
for (const target of contextTargets) {
  const result = await benchmark<ChannelMessageContextView>(
    contextPath(target.messageId, target.before, target.after)
  );
  messageContext.push({
    after: target.after,
    before: target.before,
    contentBytes: contentBytes(result.representative),
    hasMoreAfter: result.representative.hasMoreAfter,
    hasMoreBefore: result.representative.hasMoreBefore,
    label: target.label,
    messages: result.representative.messages.length,
    responseBytes: result.bytes,
    threadContext: result.representative.threadContext.length,
    threadContextTruncated: result.representative.threadContextTruncated,
    timing: timing(result),
  });
}

const pathologicalPages = [];
for (const target of [
  {
    label: "large-200kb-history-100",
    path: historyPath(stress.id, 100, (BigInt(largeSequence) + 1n).toString()),
  },
  { label: "wide-thread-latest-100", path: historyPath(stress.id, 100) },
]) {
  const result = await benchmark<ChannelHistoryPage>(target.path);
  pathologicalPages.push({
    contentBytes: contentBytes(result.representative),
    label: target.label,
    messages: result.representative.messages.length,
    responseBytes: result.bytes,
    threadContext: result.representative.threadContext.length,
    threadContextTruncated: result.representative.threadContextTruncated,
    timing: timing(result),
  });
}

// Model an existing 100-message cache, 150 messages arriving while suspended,
// and the renderer's current latest-page-only refresh, without mutating data.
const latest200 = (await requestJson<ChannelHistoryPage>(historyPath(transcript.id, 200))).value;
if (latest200.messages.length !== 200) throw new Error("Reconnect simulation needs 200 messages");
const simulatedNewMessages = latest200.messages.slice(50);
const firstSimulatedNewMessage = simulatedNewMessages[0];
if (!firstSimulatedNewMessage) throw new Error("Reconnect simulation boundary is missing");
const oldLatest = (
  await requestJson<ChannelHistoryPage>(
    historyPath(transcript.id, 100, firstSimulatedNewMessage.sequence)
  )
).value;
const currentLatest = (await requestJson<ChannelHistoryPage>(historyPath(transcript.id, 100)))
  .value;
const cached = mergeLoadedChannelHistoryPage(undefined, oldLatest, "replace");
const refreshed = mergeLoadedChannelHistoryPage(cached, currentLatest, "refresh");
const refreshedIds = new Set(refreshed.messages.map((message) => message.id));
const missing = simulatedNewMessages.filter((message) => !refreshedIds.has(message.id));
const missingTarget = missing[Math.floor(missing.length / 2)];
if (!missingTarget) throw new Error("Reconnect simulation did not produce a missing target");
const recovery = await benchmark<ChannelMessageContextView>(contextPath(missingTarget.id, 50, 50));
const recovered = mergeLoadedChannelMessageContext(refreshed, recovery.representative);

const output = JSON.stringify(
  {
    baseUrl,
    fixture: {
      stressChannelId: stress.id,
      transcriptChannelId: transcript.id,
      transcriptMessagesDiscovered,
    },
    fullHistoryTraversal,
    measuredAt: new Date().toISOString(),
    messageContext,
    pageDepth,
    pageSize,
    pathologicalPages,
    reconnectSimulation: {
      cachedBeforeReconnect: oldLatest.messages.length,
      mergedAfterLatestPageRefresh: refreshed.messages.length,
      missingFromSimulated150: missing.length,
      newestFetchedByRefresh: currentLatest.messages.length,
      recoveryContext: {
        hasMoreAfter: recovery.representative.hasMoreAfter,
        hasMoreBefore: recovery.representative.hasMoreBefore,
        messages: recovery.representative.messages.length,
        recoveredTarget: recovered.searchContext.some((message) => message.id === missingTarget.id),
        responseBytes: recovery.bytes,
        timing: timing(recovery),
      },
      simulatedNewMessages: simulatedNewMessages.length,
    },
    sampleCount,
    warmupCount,
  },
  null,
  2
);
if (process.env.OPENBOT_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENBOT_AUDIT_OUTPUT, `${output}\n`);
}
console.log(output);
