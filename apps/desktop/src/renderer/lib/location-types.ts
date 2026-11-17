import type { DeviceLocation } from "@openteam/contracts/user-location";

// IPC errors lose custom properties, so preserve geolocation error codes in a result.
export type NativeLocationResult =
  | { location: DeviceLocation }
  | { error: { code: 1 | 2 | 3; message: string } };
