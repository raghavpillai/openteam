export const detectTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Every IANA zone this runtime knows, for the Settings picker. */
export const supportedTimeZones = (): string[] => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

/** "America/New_York" → "America/New York", as the picker shows zones. */
export const timeZoneLabel = (zone: string): string => zone.replaceAll("_", " ");

/** The current time in a zone ("9:15 AM"), or null for an unknown zone. */
export const timeInZone = (zone: string, now = new Date()): string | null => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeStyle: "short", timeZone: zone }).format(now);
  } catch {
    return null;
  }
};

/**
 * Reports the zone this Mac detects to the server: at sign-in, then whenever it changes
 * (checked when the window gains focus and every few minutes), so routines and the box
 * clock follow the user when they travel. A failed report is retried at the next check.
 */
export const startTimeZoneReporting = (options: {
  detect?: () => string;
  send: (detectedTimeZone: string) => Promise<unknown>;
  intervalMs?: number;
}): (() => void) => {
  const detect = options.detect ?? detectTimeZone;
  let reported: string | null = null;
  let sending = false;
  const check = () => {
    const zone = detect();
    if (sending || zone === reported) return;
    sending = true;
    void options
      .send(zone)
      .then(() => {
        reported = zone;
        window.dispatchEvent(new Event("openteam:time-zone-changed"));
      })
      .catch(() => undefined)
      .finally(() => {
        sending = false;
      });
  };
  check();
  window.addEventListener("focus", check);
  const timer = window.setInterval(check, options.intervalMs ?? 5 * 60_000);
  return () => {
    window.removeEventListener("focus", check);
    window.clearInterval(timer);
  };
};
