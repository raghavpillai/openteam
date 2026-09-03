import { BoundedUpdateLineBuffer } from "../../apps/desktop/src/main/server-updater";
import { DesktopNotificationManager } from "../../apps/desktop/src/main/notifications";
import { desktopNotificationSnapshot } from "../../apps/desktop/src/renderer/lib/notifications";
import {
  routineSummaryProjectionEqual,
  type RoutineView,
} from "../../apps/desktop/src/renderer/lib/routines";

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

const measure = (operation: (index: number) => void, samples = 40, warmups = 5) => {
  for (let index = 0; index < warmups; index += 1) operation(index);
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    operation(index);
    durations.push(performance.now() - startedAt);
  }
  return {
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    max: Math.max(...durations),
  };
};

const notificationFixture = (count: number) =>
  ({
    cursor: "1",
    bots: Array.from({ length: count }, (_, index) => ({
      id: `bot-${index}`,
      name: `Audit Bot ${index}`,
      notificationsEnabled: true,
      hiddenFromSidebar: false,
    })),
    channels: Array.from({ length: count }, (_, index) => ({
      id: `channel-${index}`,
      kind: "bot_dm",
      name: `Audit Bot ${index}`,
      members: [{ botId: `bot-${index}` }],
      unreadCount: index % 3,
    })),
    channelMessages: Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`,
      channelId: `channel-${index}`,
      senderBotId: `bot-${index}`,
      content: `Result ${index}`,
      createdAt: `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    })),
    runs: [],
    approvals: [],
  }) as never;

const notificationSelection = [1_000, 10_000].map((count) => {
  const fixture = notificationFixture(count);
  const unreadIds = new Set<string>();
  const baseline = measure((index) => {
    structuredClone(desktopNotificationSnapshot(fixture, unreadIds, `channel-${index % count}`));
  });
  const manager = new DesktopNotificationManager({
    isFocused: () => true,
    isSupported: () => true,
    deliver: () => undefined,
    setBadge: () => undefined,
  });
  manager.sync(desktopNotificationSnapshot(fixture, unreadIds));
  const optimized = measure((index) => {
    const channelId = structuredClone(`channel-${index % count}`);
    manager.setVisibleChannel(channelId);
  });
  return { count, baseline, optimized };
});

const updaterBytes = 32 * 1024 * 1024;
const updaterChunk = "x".repeat(64 * 1024);
const updaterChunks = updaterBytes / updaterChunk.length;
const updaterBaselineStartedAt = performance.now();
let legacyPending = "";
for (let index = 0; index < updaterChunks; index += 1) {
  legacyPending += updaterChunk;
  const lines = legacyPending.split(/\r?\n/);
  legacyPending = lines.pop() ?? "";
}
const updaterBaselineMs = performance.now() - updaterBaselineStartedAt;
const updaterBuffer = new BoundedUpdateLineBuffer();
const updaterOptimizedStartedAt = performance.now();
for (let index = 0; index < updaterChunks; index += 1) updaterBuffer.push(updaterChunk);
const updaterOptimizedMs = performance.now() - updaterOptimizedStartedAt;

const mentionOptions = Array.from({ length: 10_000 }, (_, index) => ({
  label: `Audit Bot ${index}`,
  handle: `auditbot${index}`,
}));
const mentionQueries = ["", "a", "audit", "9999"];
const mentionBaseline = measure((index) => {
  const query = mentionQueries[index % mentionQueries.length] ?? "";
  mentionOptions.filter(
    (option) =>
      option.label.toLocaleLowerCase("en-US").includes(query) || option.handle.includes(query)
  );
  mentionOptions.filter(
    (option) =>
      option.label.toLocaleLowerCase("en-US").includes(query) || option.handle.includes(query)
  ).length;
});
const searchableOptions = mentionOptions.map((option) => ({
  option,
  label: option.label.toLocaleLowerCase("en-US"),
  handle: option.handle.toLocaleLowerCase("en-US"),
}));
const mentionOptimized = measure((index) => {
  const query = mentionQueries[index % mentionQueries.length] ?? "";
  searchableOptions
    .filter((option) => option.label.includes(query) || option.handle.includes(query))
    .map(({ option }) => option);
});

const mountedRows = 80;
const virtualRegistrationBaseline = measure(() => {
  const observed = new Map<object, { index: number; key: string }>();
  for (let index = 0; index < mountedRows; index += 1) {
    const node = {};
    const key = `message-${index}`;
    for (const [current, metadata] of observed) {
      if (metadata.index === index && metadata.key === key && current !== node) {
        observed.delete(current);
      }
    }
    observed.set(node, { index, key });
  }
});
const virtualRegistrationOptimized = measure(() => {
  const observed = new Map<string, object>();
  for (let index = 0; index < mountedRows; index += 1) {
    observed.set(`message-${index}`, {});
  }
});

const routineSummary = Array.from({ length: 250 }, (_, index) => ({
  id: `routine-${index}`,
  revision: 1,
  name: `Routine ${index}`,
  enabled: index % 4 !== 0,
  schedule: "0 */2 * * *",
  latestExecution: null,
})) as unknown as RoutineView[];
const unchangedRoutineSummary = structuredClone(routineSummary);
const routineRefreshBaseline = measure(() => {
  structuredClone(routineSummary).map(
    (routine) =>
      `${routine.id}:${routine.revision}:${routine.name}:${routine.enabled}:${routine.schedule}`
  );
});
const routineRefreshOptimized = measure(() => {
  routineSummaryProjectionEqual(routineSummary, unchangedRoutineSummary);
});

const output = JSON.stringify(
  {
    measuredAt: new Date().toISOString(),
    notificationSelection,
    updaterNoNewline: {
      bytes: updaterBytes,
      baselineMs: updaterBaselineMs,
      optimizedMs: updaterOptimizedMs,
      optimizedBufferedCharacters: updaterBuffer.bufferedLength,
    },
    mentionSearch10k: { baseline: mentionBaseline, optimized: mentionOptimized },
    virtualRegistration80: {
      baseline: virtualRegistrationBaseline,
      optimized: virtualRegistrationOptimized,
    },
    unchangedRoutineRefresh250: {
      baseline: routineRefreshBaseline,
      optimized: routineRefreshOptimized,
    },
  },
  null,
  2
);
if (process.env.OPENTEAM_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENTEAM_AUDIT_OUTPUT, `${output}\n`);
}
console.log(output);
