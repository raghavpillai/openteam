import { validateProcessSecretName, ApiError } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";

type Database = PrismaClient | Prisma.TransactionClient;

export async function storeProcessSecret(
  db: Database,
  botId: string,
  channelId: string,
  name: string,
  value: string,
  scope: "bot" | "personal" = "bot"
) {
  validateProcessSecretName(name);
  if (!value.trim() || value.length > 20_000)
    throw new ApiError(400, "secret_invalid", "A secret must contain 1–20000 characters");
  const channel = await db.channel.findFirst({
    where: { id: channelId, kind: "bot_dm", directKey: `bot:${botId}`, archivedAt: null },
  });
  if (!channel)
    throw new ApiError(
      403,
      "secret_owner_dm_required",
      "Process secrets can only be set in the owner's bot DM"
    );
  const ownerKey = scope === "personal" ? "personal" : `bot:${botId}`;
  try {
    await db.processSecret.upsert({
      where: { ownerKey_name: { ownerKey, name } },
      create: { ownerKey, name, value, botId: scope === "bot" ? botId : null },
      update: { value },
    });
  } catch {
    throw new ApiError(
      503,
      "secret_storage_failed",
      "The secret could not be saved; check database availability"
    );
  }
}

export async function processEnvironment(
  db: Database,
  botId: string
): Promise<Record<string, string>> {
  const child = await db.subagent.findUnique({
    where: { childBotId: botId },
    select: { parentBotId: true },
  });
  const root = child?.parentBotId ?? botId;
  const secrets = await db.processSecret.findMany({
    where: { ownerKey: { in: ["personal", `bot:${root}`] } },
  });
  return Object.fromEntries(
    secrets
      .sort((a, b) => Number(a.ownerKey !== "personal") - Number(b.ownerKey !== "personal"))
      .map((secret) => [validateProcessSecretName(secret.name), secret.value])
  );
}
