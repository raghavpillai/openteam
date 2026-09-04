import { resolve } from "node:path";
import type { ChannelMessageView, ClientSnapshot } from "@openteam/contracts";
import { mobileFixture } from "../../../apps/mobile/src/fixtures";

// This benchmark measures renderer-neutral work, not UI frame times. Point it
// at a frozen bundle to compare worktree arms without switching source files.
const modulePath =
  process.env.OPENTEAM_PERF_CORE_MODULE ??
  resolve(import.meta.dir, "../../../packages/product-core/src/index.ts");
const core: typeof import("../../../packages/product-core/src") = await import(modulePath);
const notificationPath =
  process.env.OPENTEAM_PERF_NOTIFICATION_MODULE ??
  resolve(import.meta.dir, "../../../packages/contracts/src/notification-content.ts");
const notifications: typeof import("../../../packages/contracts/src/notification-content") =
  await import(notificationPath);
const samples = Math.max(10, Number(process.env.OPENTEAM_MODEL_SAMPLES ?? 80));
const warmups = 10;
let sink = 0;
const measure = (name: string, operation: () => number) => {
  for (let index = 0; index < warmups; index += 1) sink += operation();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const before = performance.now();
    sink += operation();
    values.push(performance.now() - before);
  }
  values.sort((a, b) => a - b);
  const percentile = (value: number) =>
    values[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)]!;
  return {
    name,
    samples,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: values.at(-1),
    totalMs: values.reduce((sum, n) => sum + n, 0),
  };
};
const message = (
  sequence: number,
  channelId = "channel-0",
  content = `Message ${sequence} ${"x".repeat(256)}`
): ChannelMessageView => ({
  id: `message-${channelId}-${sequence}`,
  channelId,
  sequence: String(sequence),
  sender: "agent",
  senderBotId: "bot-0",
  sourceRunId: null,
  content,
  metadata: { type: "text" },
  createdAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
});
const fixture = (count: number): ClientSnapshot => ({
  ...mobileFixture,
  cursor: "5000",
  bots: Array.from({ length: count }, (_, index) => ({
    ...mobileFixture.bots[0]!,
    id: `bot-${index}`,
    name: `Audit Bot ${index}`,
    dmChannelId: `channel-${index}`,
  })),
  channels: Array.from({ length: count }, (_, index) => ({
    ...mobileFixture.channels[0]!,
    id: `channel-${index}`,
    name: `Audit Bot ${index}`,
    unreadCount: index % 3,
    members: [{ ...mobileFixture.channels[0]!.members[0]!, botId: `bot-${index}` }],
  })),
  channelMessages: [
    ...Array.from({ length: count - 1 }, (_, index) => message(index + 1, `channel-${index + 1}`)),
    ...Array.from({ length: 500 }, (_, index) => message(index + 2000)),
  ],
  channelRounds: [],
  runs: [],
  runItems: [],
  approvals: [],
  subagents: [],
});
const measurements: ReturnType<typeof measure>[] = [];
for (const [name, text] of [
  ["short-ascii", "Synthetic performance message. ".repeat(6)],
  ["200kb-ascii", "Large message ".repeat(15_000)],
  ["emoji", "👨‍👩‍👧‍👦".repeat(1000)],
] as const) {
  measurements.push(
    measure(
      `notification.preview/${name}`,
      () => notifications.truncateNotificationText(text).length
    )
  );
}
for (const count of [250, 1000]) {
  const snapshot = fixture(count);
  measurements.push(
    measure(
      `snapshot.index/${count}-channels`,
      () => core.createSnapshotIndex(snapshot).latestMessageByChannel.size
    )
  );
  measurements.push(
    measure(`roster.project/${count}-channels`, () => core.selectChannelRows(snapshot).length)
  );
  const caches = core.createSnapshotCaches();
  const encoded = JSON.stringify(snapshot);
  let previous: ClientSnapshot | null = null;
  measurements.push(
    measure(`snapshot.decode-and-reconcile/${count}-channels`, () => {
      previous = core.reconcileClientSnapshot(JSON.parse(encoded), previous, caches);
      return previous.channels.length;
    })
  );
}

const historyPage = (start: number) => ({
  channelId: "channel-0",
  messages: Array.from({ length: 100 }, (_, i) => message(start + i)),
  threadContext: [],
  threadContextTruncated: false,
  beforeSequence: String(start),
  hasMore: start > 1,
  revision: "5000",
});
const historyStore = core.createChannelHistoryStore();
historyStore.acceptPage(historyPage(2400), "replace");
for (const start of [2300, 2200, 2100, 2000]) historyStore.acceptPage(historyPage(start), "older");
historyStore.setViewport("channel-0", ["message-channel-0-2499"], true);
const latest = historyPage(2400);
measurements.push(
  measure("history.refresh/500-retained", () => {
    historyStore.acceptPage(structuredClone(latest), "refresh");
    return historyStore.visible("channel-0")!.length;
  })
);
measurements.push(
  measure("history.read-projections/500-retained", () => {
    const visible = historyStore.visible("channel-0")!;
    const retained = historyStore.retained("channel-0")!;
    return visible.length + retained.length;
  })
);

const snapshot = fixture(1000);
for (const count of [1, 20, 500, 1000]) {
  const records = Array.from({ length: count }, (_, index) => {
    const target = { channelId: "channel-0", conversationId: null };
    const payload = { content: `Queued message ${index}`, attachments: [] };
    return {
      nonce: `queued-${index}`,
      lineageId: `queued-${index}`,
      priorNonces: [],
      target,
      payload,
      promptDigest: core.durableSendPromptDigest(payload, target),
      phase: "queued" as const,
      createdAtMs: 1_800_000_000_000 + index,
      updatedAtMs: 1,
      attemptCount: 0,
      dispatchStartedAtMs: null,
      queuedAtMs: 1,
      acceptedAtMs: null,
      acceptedMessage: null,
      failedAtMs: null,
      failure: null,
    };
  });
  measurements.push(
    measure(
      `outgoing.project/${count}-queued-1499-authoritative`,
      () => core.projectOutgoingMessages(snapshot.channelMessages, records).length
    )
  );
}
const wide = [
  message(1),
  ...Array.from({ length: 250 }, (_, index) => ({
    ...message(index + 2),
    metadata: { replyTo: "message-channel-0-1", branched: true },
  })),
];
const deep = [
  message(1),
  ...Array.from({ length: 125 }, (_, index) => ({
    ...message(index + 2),
    metadata: { replyTo: `message-channel-0-${index + 1}`, branched: true },
  })),
];
for (const [name, messages] of [
  ["wide-250", wide],
  ["deep-125", deep],
] as const) {
  measurements.push(measure(`threads.derive/${name}`, () => core.deriveThreads(messages).size));
}
const long = message(
  1,
  "channel-0",
  "# Report\n\n" + "Long Markdown **content** with `inline code`.\n".repeat(5000)
);
measurements.push(
  measure(
    "message.project/200kb-markdown",
    () => core.messageDisplayProjection(long).displayContent.length
  )
);
const result = {
  measuredAt: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  modulePath,
  notificationPath,
  warmups,
  samples,
  measurementClass: "renderer-neutral synchronous algorithm; not device latency",
  measurements,
  sink,
};
const output = `${JSON.stringify(result, null, 2)}\n`;
if (process.env.OPENTEAM_AUDIT_OUTPUT) await Bun.write(process.env.OPENTEAM_AUDIT_OUTPUT, output);
console.log(output);
