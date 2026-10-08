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

const pluginOwner = (pluginKey: string) => `plugin:${pluginKey}`;

/** Secrets entered in a plugin's setup; every Bot's processes receive them like personal secrets. */
export async function storePluginEnvironment(
  db: Database,
  pluginKey: string,
  values: Array<[name: string, value: string]>
) {
  for (const [name, value] of values) {
    validateProcessSecretName(name);
    if (!value.trim() || value.length > 20_000)
      throw new ApiError(400, "secret_invalid", "A secret must contain 1–20000 characters");
    await db.processSecret.upsert({
      where: { ownerKey_name: { ownerKey: pluginOwner(pluginKey), name } },
      create: { ownerKey: pluginOwner(pluginKey), name, value, botId: null },
      update: { value },
    });
  }
}

export async function clearPluginEnvironment(db: Database, pluginKey: string) {
  await db.processSecret.deleteMany({ where: { ownerKey: pluginOwner(pluginKey) } });
}

export async function pluginEnvironmentNames(db: Database, pluginKey: string): Promise<string[]> {
  const secrets = await db.processSecret.findMany({
    where: { ownerKey: pluginOwner(pluginKey) },
    select: { name: true },
  });
  return secrets.map((secret) => secret.name);
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
    where: {
      OR: [
        { ownerKey: { in: ["personal", `bot:${root}`] } },
        { ownerKey: { startsWith: "plugin:" } },
      ],
    },
  });
  // Later sources override earlier ones: plugin setup, then personal, then this Bot.
  const precedence = (ownerKey: string) =>
    ownerKey.startsWith("plugin:") ? 0 : ownerKey === "personal" ? 1 : 2;
  return Object.fromEntries(
    secrets
      .sort((a, b) => precedence(a.ownerKey) - precedence(b.ownerKey))
      .map((secret) => [validateProcessSecretName(secret.name), secret.value])
  );
}
