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
          title="Pause alerts on other devices while I’m active"
          description="Use your iPhone while OpenTeam is open there. Otherwise, keep phone alerts quiet while you’re using your Mac. Phone alerts resume after five minutes of Mac inactivity."
          control={
            <InteractiveSwitch
              label="Pause alerts on other devices while I’m active"
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
