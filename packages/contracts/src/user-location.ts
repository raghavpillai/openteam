import { Schema } from "effect";

/** A device's location fix, sent with a message while Share location is on in that app's settings. */
export const DeviceLocation = Schema.Struct({
  latitude: Schema.Number.pipe(Schema.between(-90, 90)),
  longitude: Schema.Number.pipe(Schema.between(-180, 180)),
  /** The radius, in meters, the fix is good to. */
  accuracyMeters: Schema.optional(Schema.Number.pipe(Schema.between(0, 10_000_000))),
  /** When the device took the fix, ISO 8601. */
  capturedAt: Schema.String.pipe(Schema.filter((value) => !Number.isNaN(Date.parse(value)))),
  device: Schema.Literal("phone", "computer"),
});
export type DeviceLocation = typeof DeviceLocation.Type;

export const GET_USER_LOCATION_TOOL = {
  name: "GetUserLocation",
  description:
    "Get the user's latest location: the one their phone or computer sent with their most recent message, while Share location is on in the app's Settings. Use it whenever the answer depends on where the user is, such as \"near me\", \"the weather here\" or directions from where they are, and pass the coordinates to a places tool to find what is nearby. The result is JSON with latitude and longitude in degrees, accuracyMeters (the radius the fix is good to), capturedAt (when the device took it), ageMinutes and device (phone or computer). It is where the user was when they last sent a message, so when ageMinutes is large, say how old it is or check with the user. When accuracyMeters is large (a computer's Wi-Fi fix is often coarser than a phone's GPS), don't claim street-level precision. It returns coordinates only, not an address or place name. When no location is shared, ask the user where they are, or to turn on Share location in Settings.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

export type UserLocationView = DeviceLocation & { ageMinutes: number };

/** The tool's answer for the stored fix, or why there is none. */
export const userLocationToolResult = (
  stored: { latitude: number; longitude: number; accuracyMeters: number | null; capturedAt: Date; device: string } | null,
  now = new Date()
): UserLocationView | { available: false; reason: string } =>
  stored
    ? {
        latitude: stored.latitude,
        longitude: stored.longitude,
        ...(stored.accuracyMeters === null ? {} : { accuracyMeters: Math.round(stored.accuracyMeters) }),
        capturedAt: stored.capturedAt.toISOString(),
        ageMinutes: Math.max(0, Math.round((now.getTime() - stored.capturedAt.getTime()) / 60_000)),
        device: stored.device === "computer" ? "computer" : "phone",
      }
    : {
        available: false,
        reason:
          "The user has not shared a location: Share location is off in the app's Settings on their phone and computer, or they have not sent a message since turning it on. Ask where they are, or ask them to turn on Share location in Settings and send their next message from that device.",
      };
