import { expect, test } from "bun:test";
import { Schema } from "effect";
import { SendMessageInput } from "@openteam/contracts";
import { userLocationToolResult } from "@openteam/contracts/user-location";
import { createPrismaClient } from "@openteam/db";
import { clearUserLocation, readUserLocation, recordUserLocation } from "../src/services/user-location";

const fix = (latitude: number, capturedAt: string, device: "phone" | "computer" = "phone") =>
  ({ latitude, longitude: -73.99, accuracyMeters: 35.4, capturedAt, device });

test("a send accepts a well-formed location and refuses an impossible one", () => {
  const decode = Schema.decodeUnknownEither(SendMessageInput);
  const base = { content: "coffee near me?", clientId: "client-0001" };
  expect(decode({ ...base, location: fix(40.75, "2026-11-14T10:00:00Z") })._tag).toBe("Right");
  for (const location of [fix(91, "2026-11-14T10:00:00Z"), fix(40, "yesterday"), { ...fix(40, "2026-11-14T10:00:00Z"), device: "watch" }])
    expect(decode({ ...base, location })._tag).toBe("Left");
});

test("the tool reports the fix with its age, or says why there is none", () => {
  const now = new Date("2026-11-14T10:30:00Z");
  expect(userLocationToolResult({ latitude: 40.75, longitude: -73.99, accuracyMeters: 35.4, capturedAt: new Date("2026-11-14T10:00:00Z"), device: "computer" }, now))
    .toEqual({ latitude: 40.75, longitude: -73.99, accuracyMeters: 35, capturedAt: "2026-11-14T10:00:00.000Z", ageMinutes: 30, device: "computer" });
  expect(userLocationToolResult(null, now)).toMatchObject({ available: false });
});

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)("each send replaces the stored location, and turning sharing off forgets it", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const now = new Date("2026-11-14T10:30:00Z");
  try {
    await clearUserLocation(prisma);
    expect(await readUserLocation(prisma, now)).toMatchObject({ available: false });
    await prisma.$transaction((tx) => recordUserLocation(tx, fix(40.75, "2026-11-14T10:20:00Z", "computer"), now));
    // The newest message wins, whichever device sent it; a clock ahead of the server's reads as now.
    await prisma.$transaction((tx) => recordUserLocation(tx, fix(37.77, "2026-11-14T11:00:00Z"), now));
    expect(await readUserLocation(prisma, now)).toEqual({ latitude: 37.77, longitude: -73.99, accuracyMeters: 35, capturedAt: now.toISOString(), ageMinutes: 0, device: "phone" });
    expect(await prisma.userLocation.count()).toBe(1);
    await clearUserLocation(prisma);
    expect(await readUserLocation(prisma, now)).toMatchObject({ available: false });
  } finally {
    await prisma.$disconnect();
  }
});
