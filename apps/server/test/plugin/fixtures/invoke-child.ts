/** Separate host process for SIGKILL recovery tests; never runs a coding agent. */
import { createPrismaClient } from "@openteam/db";
import { PluginService } from "../../../src/services/plugin-service";

const [connectionId, botId, runId, callId] = process.argv.slice(2);
if (!process.env.OPENTEAM_TEST_DATABASE_URL || !connectionId || !botId || !runId || !callId)
  throw new Error("Disposable database and invocation identifiers are required");
const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
const service = new PluginService(db);
try {
  await service.invoke({ connectionId, botId, runId, callId, toolName: "whoami", arguments: {} });
} finally {
  await service.close();
  await db.$disconnect();
}
