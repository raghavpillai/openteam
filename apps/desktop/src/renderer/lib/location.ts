import type { DeviceLocation } from "@openteam/contracts/user-location";

/** Location sharing on this computer: off until the user turns it on in Settings. */
export const LOCATION_SHARING_KEY = "openteam:location-sharing";
const CHANGE_EVENT = "openteam:location-sharing-change";
/** A fix this recent goes out as is; an older one is refreshed first. */
const FRESH_MS = 5 * 60_000;
/** How long a send waits for a fresh fix before it goes with what it has. */
const SEND_WAIT_MS = 1_500;

export const readLocationSharing = (): boolean => {
  try {
    return localStorage.getItem(LOCATION_SHARING_KEY) === "true";
  } catch {
    return false;
  }
};

export const subscribeLocationSharing = (listener: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCATION_SHARING_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
};

let latest: DeviceLocation | undefined;
let pending: Promise<DeviceLocation> | undefined;

const toLocation = (position: GeolocationPosition): DeviceLocation => ({
  latitude: position.coords.latitude,
  longitude: position.coords.longitude,
  ...(Number.isFinite(position.coords.accuracy) ? { accuracyMeters: position.coords.accuracy } : {}),
  capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
  device: "computer",
});

/** Asks the system for a fix; the first call is what shows the OS permission prompt. */
export const readPosition = (timeoutMs = 20_000): Promise<DeviceLocation> => {
  pending ??= new Promise<DeviceLocation>((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Location is not available on this computer."));
    navigator.geolocation.getCurrentPosition(
      (position) => resolve((latest = toLocation(position))),
      (error) => reject(error),
      { enableHighAccuracy: false, maximumAge: FRESH_MS, timeout: timeoutMs }
    );
  }).finally(() => {
    pending = undefined;
  });
  return pending;
};

export const setLocationSharing = (enabled: boolean): void => {
  try {
    localStorage.setItem(LOCATION_SHARING_KEY, String(enabled));
  } catch {
    // Without storage the switch only lasts this session.
  }
  if (!enabled) latest = undefined;
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

/** The location a message carries: undefined while sharing is off, or when no fix comes in time. */
export async function locationForSend(): Promise<DeviceLocation | undefined> {
  if (!readLocationSharing()) return undefined;
  if (latest && Date.now() - Date.parse(latest.capturedAt) < FRESH_MS) return latest;
  const fresh = readPosition().catch(() => undefined);
  const timedOut = new Promise<undefined>((resolve) => setTimeout(resolve, SEND_WAIT_MS));
  return (await Promise.race([fresh, timedOut])) ?? latest;
}

/** Keeps the fix current while the app is in use, so sends rarely wait. */
export function watchLocationWhileFocused(): () => void {
  const refresh = () => {
    if (readLocationSharing() && document.visibilityState === "visible") void readPosition().catch(() => undefined);
  };
  refresh();
  window.addEventListener("focus", refresh);
  const unsubscribe = subscribeLocationSharing(refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    unsubscribe();
  };
}
