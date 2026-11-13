import { InteractiveSwitch } from "./interactive-switch";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../client/openteam-api";
import {
  SectionLabel,
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SkeletonSwitch,
} from "./ui";

const TITLE = "Pause iPhone alerts while using this Mac";
const DESCRIPTION =
  "Alerts resume after 5 minutes of inactivity or when you open OpenTeam on Mobile.";

export function SmartNotificationSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
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
          // The section is left out when the setting can't load; a later change event retries.
          if (active) setUnavailable(true);
        });
    };
    refresh();
    window.addEventListener("openteam:notification-preferences-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("openteam:notification-preferences-changed", refresh);
    };
  }, []);
  if (enabled === null && unavailable) return null;
  return (
    <>
      <SectionLabel>Notifications</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title={TITLE}
          description={DESCRIPTION}
          control={
            enabled === null ? (
              <SkeletonSwitch />
            ) : (
              <SettingsReveal className="flex">
                <InteractiveSwitch
                  label={TITLE}
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
              </SettingsReveal>
            )
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
