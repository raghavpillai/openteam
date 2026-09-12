import { Effect } from "/Users/raghav/OpenBot/apps/server/node_modules/effect";
import { createPrismaClient } from "/Users/raghav/OpenBot/packages/db/src/index.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";

const [auditRoot, output] = process.argv.slice(2);
const { port } = await Bun.file(join(auditRoot!, "postgres.json")).json();
const prisma = createPrismaClient(`postgresql://regression@127.0.0.1:${port}/openteam_perf_audit`);
const fakeComputer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ status: "ready", inference: { ready: true, authenticated: true } }) });
await prisma.computer.upsert({ where: { id: "00000000-0000-0000-0000-000000000001" }, create: { id: "00000000-0000-0000-0000-000000000001", status: "ready" }, update: { status: "ready" } });
const services: Record<string, any> = {};
for (const arm of ["baseline", "candidate"]) {
  const source = join(auditRoot!, arm, "apps/server/src/services");
  const { SnapshotService } = await import(join(source, "snapshot-service.ts"));
  const { SearchService } = await import(join(source, "search-service.ts"));
  services[arm] = {
    snapshots: new SnapshotService(prisma, "/qa-workspace", `http://127.0.0.1:${fakeComputer.port}`, () => true),
    search: new SearchService(prisma),
  };
}
const channel = await prisma.channel.findFirstOrThrow({ where: { name: "Audit Bot 0001" } });
const target = await prisma.channelMessage.findFirstOrThrow({ where: { channelId: channel.id }, orderBy: { sequence: "desc" }, skip: 100 });
const workloads = [
  { name: "bootstrap-1000-bots", run: (s: any) => s.snapshots.bootstrap() },
  { name: "client-snapshot", run: (s: any) => s.snapshots.client() },
  { name: "history-100", run: (s: any) => s.snapshots.history(channel.id, null, 100) },
  { name: "message-context-101", run: (s: any) => s.snapshots.messageContext(target.id, 50, 50) },
  { name: "channel-activity", run: (s: any) => s.snapshots.channelState(channel.id) },
  { name: "search-all", run: (s: any) => s.search.search("audit", "all") },
  { name: "search-messages", run: (s: any) => s.search.search("audit", "messages") },
];
const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const results = [];
try {
  for (const workload of workloads) {
    const baseline = await Effect.runPromise(workload.run(services.baseline));
    const candidate = await Effect.runPromise(workload.run(services.candidate));
    assert.deepStrictEqual(candidate, baseline, `${workload.name} output differs`);
    for (let i = 0; i < 8; i++) for (const arm of i % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) await Effect.runPromise(workload.run(services[arm]));
    const samples: Record<string, number[]> = { baseline: [], candidate: [] };
    for (let i = 0; i < 60; i++) {
      for (const arm of i % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        const start = performance.now();
        await Effect.runPromise(workload.run(services[arm]));
        samples[arm]!.push(performance.now() - start);
      }
    }
    const row = { name: workload.name, unit: "milliseconds", outputSha256: digest(baseline), outputBytes: Buffer.byteLength(JSON.stringify(baseline)), samples };
    results.push(row);
    console.log(JSON.stringify({ name: row.name, bytes: row.outputBytes, medianMs: Object.fromEntries(Object.entries(samples).map(([arm, values]) => [arm, [...values].sort((a,b)=>a-b)[30]])) }));
  }
  await Bun.write(output!, JSON.stringify({ fixture: { bots: 1000, groups: 100, longTranscript: 10000 }, warmups: 8, pairedSamples: 60, results }, null, 2));
} finally {
  fakeComputer.stop();
  await prisma.$disconnect();
}
