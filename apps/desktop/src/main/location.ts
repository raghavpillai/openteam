import { createRequire } from "node:module";
import type { NativeLocationResult } from "../renderer/lib/location-types";

type NativePosition =
  | { code: 0; latitude: number; longitude: number; accuracy: number; timestamp: number }
  | { code: 1 | 2 | 3 };
type LocationModule = { readPosition: (timeout: number) => Promise<NativePosition> };
let native: LocationModule | undefined;

export async function readNativePosition(modulePath: string): Promise<NativeLocationResult> {
  try {
    native ??= createRequire(import.meta.url)(modulePath) as LocationModule;
    const result = await native.readPosition(20_000);
    if (result.code !== 0) {
      return { error: {
        code: result.code,
        message: result.code === 1
          ? "OpenTeam isn’t allowed to use your location."
          : result.code === 3 ? "Getting this computer’s location timed out." : "Location is unavailable.",
      } };
    }
    return { location: {
      latitude: result.latitude,
      longitude: result.longitude,
      accuracyMeters: result.accuracy,
      capturedAt: new Date(result.timestamp).toISOString(),
      device: "computer",
    } };
  } catch {
    return { error: { code: 2, message: "Location is unavailable. Reinstall or update OpenTeam and try again." } };
  }
}
