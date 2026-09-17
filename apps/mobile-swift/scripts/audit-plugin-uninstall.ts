/** Production API/database receipt for native lost-uninstall-response recovery. Disposable data only. */
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../../packages/db/src/index";
const prisma = createPrismaClient("postgresql://swiftqa:swiftqa-disposable-only@127.0.0.1:20002/swiftqa_live");
const base = "http://127.0.0.1:20005";
const key = "native-uninstall-audit-" + randomUUID();
await prisma.pluginInstallation.create({ data: { pluginKey: key, name: "Native uninstall audit", version: "1.0.0", publisher: "Disposable QA", manifest: { key, name: "Native uninstall audit", version: "1.0.0", skills: [], connections: [] } } });
try {
  const first = await fetch(base + "/api/v0/plugins/" + key, { method: "DELETE" });
  const firstBody = await first.json();
  const afterFirst = await prisma.pluginInstallation.findUnique({ where: { pluginKey: key } });
  const retry = await fetch(base + "/api/v0/plugins/" + key, { method: "DELETE" });
  const retryBody = await retry.json();
  const report = { finding: "QA-22", source: "Production HTTP API and disposable PostgreSQL", firstStatus: first.status, firstBody, removedAfterFirstRequest: afterFirst === null, retryStatus: retry.status, retryBody, note: "The simulator test injects loss of the first acknowledgment. This receipt verifies the real server's successful removal and 404 retry contract." };
  console.log(JSON.stringify(report, null, 2));
  if (!first.ok || afterFirst || retry.status !== 404) throw new Error("Uninstall retry contract did not reproduce.");
} finally {
  await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } });
  await prisma.$disconnect();
}
