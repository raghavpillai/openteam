import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@openteam/db";
import { AgentMessaging } from "../src";
import { nextRoutineRun, RoutineService } from "../src/routines";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

/** The wall-clock hour and minute of an instant in a zone, as "HH:MM". */
const wallClock = (at: Date | null, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at!);

test.skipIf(!databaseUrl)("routines follow the user's zone; ones scheduled before it was known keep their moments", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const channelId = randomUUID();
  const botId = randomUUID();
  const owner = { kind: "group" as const, id: channelId };
  const routines = new RoutineService(prisma, { enqueueWake: async () => ({ run: { id: randomUUID() } }) });
  const messaging = Object.create(AgentMessaging.prototype) as AgentMessaging;
  const written: string[] = [];
  Object.assign(messaging, { prisma, agentData: { writeRoutine: async (_bot: string, id: string) => void written.push(id) } });
  const setZone = (update: { detected?: string; override?: string | null }) =>
    prisma.$transaction((tx) => messaging.updateUserTimeZone(tx, update));
  const create = async (name: string) =>
    String((await routines.mutateOwner(owner, randomUUID(), null, {
      action: "create", name, prompt: "Post the standup.", schedule: "15 9 * * 1-5",
    })).id);
  const previousZone = await prisma.userTimeZoneSettings.findUnique({ where: { id: "global" } });
  try {
    await prisma.userTimeZoneSettings.deleteMany({ where: { id: "global" } });
    await prisma.channel.create({ data: { id: channelId, kind: "group", name: "Time zone test" } });
    await prisma.bot.create({ data: { id: botId, name: "Time zone fixture", defaultDirectory: "/tmp/tz-test", status: "active",
      conversation: { create: { id: randomUUID() } }, channelMemberships: { create: { channelId, ordinal: 0 } } } });

    // Before any app reports a zone, routines run on UTC.
    expect(await messaging.userTimeZone()).toBe("UTC");
    const early = await create("Before the app connected");
    const scheduledEarly = await prisma.routine.findUniqueOrThrow({ where: { id: early } });
    expect(scheduledEarly).toMatchObject({ timezone: "UTC", timezoneMode: "installation" });
    expect(wallClock(scheduledEarly.nextRunAt, "UTC")).toBe("09:15");

    // The first report pins it to UTC, so it keeps firing at the same moment.
    expect(await setZone({ detected: "america/new_york" })).toEqual({
      detectedTimeZone: "America/New_York", overrideTimeZone: null, timeZone: "America/New_York",
    });
    const pinned = await prisma.routine.findUniqueOrThrow({ where: { id: early } });
    expect(pinned).toMatchObject({ scheduleText: "CRON_TZ=UTC 15 9 * * 1-5", timezoneMode: "pinned", timezone: "UTC" });
    expect(pinned.trigger).toEqual({ type: "cron", schedule: "CRON_TZ=UTC 15 9 * * 1-5" });
    expect(pinned.triggerPresentation).toEqual({ version: 1, trigger: { type: "cron", schedule: "CRON_TZ=UTC 15 9 * * 1-5" } });
    expect(pinned.nextRunAt).toEqual(scheduledEarly.nextRunAt);

    // New routines run on the user's clock, and the UpdateRoutine result says so.
    const standup = await create("Standup");
    const created = await prisma.routine.findUniqueOrThrow({ where: { id: standup } });
    expect(created).toMatchObject({ timezone: "America/New_York", timezoneMode: "installation" });
    expect(wallClock(created.nextRunAt, "America/New_York")).toBe("09:15");

    // Repeats are no-ops; a trip moves the routine to the new zone's 9:15.
    await setZone({ detected: "America/New_York" });
    await setZone({ detected: "Europe/London" });
    const travelled = await prisma.routine.findUniqueOrThrow({ where: { id: standup } });
    expect(travelled.timezone).toBe("Europe/London");
    expect(wallClock(travelled.nextRunAt, "Europe/London")).toBe("09:15");
    expect(travelled.nextRunAt).toEqual(nextRoutineRun({ ...travelled, timezone: "Europe/London" }, new Date()));
    expect((await prisma.routine.findUniqueOrThrow({ where: { id: early } })).nextRunAt).toEqual(scheduledEarly.nextRunAt);

    // The Settings override wins over whatever the devices detect, until it is cleared.
    expect((await setZone({ override: "Asia/Tokyo" })).timeZone).toBe("Asia/Tokyo");
    expect((await setZone({ detected: "America/Chicago" })).timeZone).toBe("Asia/Tokyo");
    expect((await prisma.routine.findUniqueOrThrow({ where: { id: standup } })).timezone).toBe("Asia/Tokyo");
    expect(await setZone({ override: null })).toEqual({
      detectedTimeZone: "America/Chicago", overrideTimeZone: null, timeZone: "America/Chicago",
    });
    expect(wallClock((await prisma.routine.findUniqueOrThrow({ where: { id: standup } })).nextRunAt, "America/Chicago")).toBe("09:15");

    // Unknown zones: a device's is ignored, an override is refused.
    expect((await setZone({ detected: "Not/AZone" })).timeZone).toBe("America/Chicago");
    await expect(setZone({ override: "Not/AZone" })).rejects.toThrow("Unknown time zone: Not/AZone");
    expect(written).toEqual([]);
  } finally {
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.userTimeZoneSettings.deleteMany({ where: { id: "global" } });
    if (previousZone) await prisma.userTimeZoneSettings.create({ data: previousZone });
    await prisma.$disconnect();
  }
});
