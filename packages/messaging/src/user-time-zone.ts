import type { UserTimeZoneView } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import { resolveTimeZone } from "./timestamps";

type TimeZoneDb = Pick<PrismaClient | Prisma.TransactionClient, "userTimeZoneSettings">;
type StoredTimeZone = { detected: string | null; override: string | null } | null;

/** The IANA spelling Intl uses for a zone ("america/new_york" → "America/New_York"), or null. */
export const canonicalTimeZone = (value: string): string | null => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

export const userTimeZoneView = (row: StoredTimeZone): UserTimeZoneView => ({
  detectedTimeZone: row?.detected ?? null,
  overrideTimeZone: row?.override ?? null,
  timeZone: resolveTimeZone(row?.override ?? row?.detected),
});

/** The zone the user lives in: their Settings override, else the zone their apps last detected. */
export const readUserTimeZone = async (db: TimeZoneDb): Promise<string> =>
  userTimeZoneView(await db.userTimeZoneSettings.findUnique({ where: { id: "global" } })).timeZone;
