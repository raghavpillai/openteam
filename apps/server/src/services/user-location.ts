import { userLocationToolResult, type DeviceLocation } from "@openteam/contracts/user-location";
import type { Prisma, PrismaClient } from "@openteam/db";

/** Each message sent with Share location on replaces the stored location, so the newest message wins.
 * A fix stamped ahead of the server's clock is treated as taken now. */
export async function recordUserLocation(tx: Prisma.TransactionClient, location: DeviceLocation, now = new Date()) {
  const captured = new Date(Math.min(Date.parse(location.capturedAt), now.getTime()));
  const data = {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracyMeters: location.accuracyMeters ?? null,
    capturedAt: captured,
    device: location.device,
  };
  await tx.userLocation.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
}

/** Turning Share location off on any device forgets the stored location. */
export async function clearUserLocation(prisma: Pick<PrismaClient, "userLocation">) {
  await prisma.userLocation.deleteMany({});
  return { cleared: true };
}

export async function readUserLocation(prisma: Pick<PrismaClient, "userLocation">, now = new Date()) {
  return userLocationToolResult(await prisma.userLocation.findUnique({ where: { id: "global" } }), now);
}
