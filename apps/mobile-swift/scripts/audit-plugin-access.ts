/** Actual native payloads against production plugin routes and disposable Postgres. No provider calls. */
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../../packages/db/src/index";
const prisma = createPrismaClient("postgresql://swiftqa:swiftqa-disposable-only@127.0.0.1:20002/swiftqa_live");
const base = "http://127.0.0.1:20005";
async function request(path: string, method = "GET", body?: unknown) {
  const result = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!result.ok) throw new Error(`Audit request failed: ${result.status} ${path}`);
  return result.json() as Promise<any>;
}
const bot = await prisma.bot.findFirstOrThrow({ where: { status: { not: "archived" } } });
const key = "native-access-audit-" + randomUUID();
const installation = await prisma.pluginInstallation.create({ data: { pluginKey: key, name: "Native access audit", version: "1.0.0", publisher: "Disposable QA", manifest: { key, name: "Native access audit", version: "1.0.0", skills: [], connections: [] } } });
try {
  const connection = await prisma.pluginConnection.create({ data: { installationId: installation.id, connectorKey: "audit", name: "Audit account", transport: "http", authType: "none", endpoint: "https://example.invalid/audit", status: "ready" } });
  const invalidPage = await fetch(base + `/api/v0/plugins/${key}/bot-access?limit=100&offset=0&q=`);
  const pageFailure = { status: invalidPage.status, body: await invalidPage.json() };
  const payload = { botId: bot.id, enabled: true, skillsEnabled: true };
  await request(`/api/v0/plugins/${key}/enablement`, "POST", payload);
  const afterEnable = (await request(`/api/v0/plugins/${key}/bot-access?limit=60`)).bots.find((b: any) => b.id === bot.id);
  await request(`/api/v0/plugin-connections/${connection.id}/grant`, "POST", { botId: bot.id, enabled: true });
  await request(`/api/v0/plugins/${key}/enablement`, "POST", { botId: bot.id, enabled: false, skillsEnabled: false });
  const afterDisable = (await request(`/api/v0/plugins/${key}/bot-access?limit=60`)).bots.find((b: any) => b.id === bot.id);
  const enabled = await prisma.botPluginEnablement.findUniqueOrThrow({ where: { botId_installationId: { botId: bot.id, installationId: installation.id } } });
  const report = { findings: ["QA-09", "QA-10"], nativePageFailure: pageFailure, nativeEnablePayload: payload, afterEnable, noConnectedAccountsGranted: afterEnable.grantedConnectionIds.length === 0, afterDisable, actualBackendEnabledAfterDisable: enabled.enabled, nativeSwitchStillAppearsOn: afterDisable.skillsEnabled || afterDisable.grantedConnectionIds.length > 0 };
  console.log(JSON.stringify(report, null, 2));
  if (!report.noConnectedAccountsGranted || !report.nativeSwitchStillAppearsOn || enabled.enabled) throw new Error("The access mismatch did not reproduce.");
} finally {
  await prisma.pluginInstallation.delete({ where: { id: installation.id } });
  await prisma.$disconnect();
}
