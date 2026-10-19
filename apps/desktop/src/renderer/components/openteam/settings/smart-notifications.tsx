import { useEffect, useRef, useState } from "react";
import { api } from "../../../client/openteam-api";
import { InteractiveSwitch, SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export function SmartNotificationSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastResponse = useRef(-1);
  const apply = (value: { serverTime: number; smartEnabled: boolean }) => {
    if (value.serverTime < lastResponse.current) return;
    lastResponse.current = value.serverTime;
    setEnabled(value.smartEnabled);
  };
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api
        .notificationPreferences()
        .then((value) => {
          if (active) apply(value);
        })
        .catch(() => {
          /* Older servers don't expose this setting. */
        });
    };
    refresh();
    window.addEventListener("openteam:notification-preferences-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("openteam:notification-preferences-changed", refresh);
    };
  }, []);
  if (enabled === null) return null;
  return (
    <>
      <SectionLabel>Notifications</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Pause iPhone alerts while I’m using this Mac"
          description="Phone alerts stay quiet while you’re using your Mac, unless OpenTeam is open on your iPhone. They resume after five minutes of Mac inactivity."
          control={
            <InteractiveSwitch
              label="Pause iPhone alerts while I’m using this Mac"
              checked={enabled}
              disabled={saving}
              onChange={(value) => {
                setSaving(true);
                setError(null);
                void api
                  .updateNotificationPreferences(value)
                  .then(apply)
                  .catch(() => setError("Couldn’t save notification settings. Try again."))
                  .finally(() => setSaving(false));
              }}
            />
          }
        />
        {error && (
          <p role="alert" className="pb-3 text-xs text-destructive">
            {error}
          </p>
        )}
      </SettingsGroup>
    </>
  );
}
