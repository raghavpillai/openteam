import { InteractiveSwitch } from "./interactive-switch";
import { useState, useSyncExternalStore } from "react";
import { api } from "../../../client/openteam-api";
import { readLocationSharing, readPosition, setLocationSharing, subscribeLocationSharing } from "../../../lib/location";
import { Button } from "../../ui/button";
import { SectionLabel, SettingsGroup, SettingsRow, settingsSecondaryButton } from "./ui";

const TITLE = "Share location";
const DESCRIPTION =
  "Messages you send from this computer include its location, so bots can answer questions like what’s near you. Turning it off forgets the shared location.";

export function LocationSettings() {
  const enabled = useSyncExternalStore(subscribeLocationSharing, readLocationSharing);
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (value: boolean) => {
    setBusy(value ? "enable" : "disable");
    setDenied(false);
    setError(null);
    try {
      if (value) {
        // Asking for a fix is what shows the system's permission prompt.
        await readPosition();
        setLocationSharing(true);
      } else {
        setLocationSharing(false);
        await api.clearUserLocation();
      }
    } catch (cause) {
      const code = (cause as GeolocationPositionError | undefined)?.code;
      if (code === 1) setDenied(true);
      else setError(value ? "Couldn’t get this computer’s location. Try again." : "Couldn’t forget the shared location. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SectionLabel>Location</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title={TITLE}
          description={DESCRIPTION}
          control={<InteractiveSwitch label={TITLE} checked={enabled} disabled={busy !== null} onChange={(value) => void change(value)} />}
        />
        {denied && (
          <div role="alert" className="flex flex-wrap items-center gap-2 pb-3 text-xs text-destructive">
            <span>OpenTeam isn’t allowed to use your location. Turn on Location Services and allow OpenTeam in System Settings, then try again.</span>
            {window.openteam?.location ? (
              <Button size="xs" variant="secondary" className={settingsSecondaryButton} type="button" onClick={() => void window.openteam?.location?.openSettings()}>
                Open System Settings
              </Button>
            ) : null}
          </div>
        )}
        {error && (
          <p role="alert" className="pb-3 text-xs text-destructive">
            {error}
          </p>
        )}
        {busy === "enable" && <p role="status" className="pb-3 text-xs text-muted-foreground">Getting your location… Allow access if your computer asks.</p>}
      </SettingsGroup>
    </>
  );
}
