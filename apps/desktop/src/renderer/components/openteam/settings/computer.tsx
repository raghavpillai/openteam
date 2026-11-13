import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { useEffect, useState } from "react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import {
  SectionLabel,
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SkeletonControl,
  SkeletonSwitch,
  settingsInput,
  settingsSecondaryButton,
} from "./ui";
import { MessagesSettings } from "./messages";

// Asked for as soon as this code loads (Settings preloads it on open) and kept between
// visits, so the section renders complete; each visit still refreshes it.
let lastComputer: OpenTeamComputerSettings | null = null;
void window.openteam?.computer
  .get()
  .then((value) => {
    lastComputer ??= value;
  })
  .catch(() => undefined);

export default function ComputerSettings() {
  const [computer, setComputer] = useState<OpenTeamComputerSettings | null>(() => lastComputer);
  const [machineLabel, setMachineLabel] = useState(() => lastComputer?.machine.label ?? "");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  useEffect(() => {
    if (computer) lastComputer = computer;
  }, [computer]);

  useEffect(() => {
    let active = true;
    window.openteam?.computer
      .get()
      .then((value) => {
        if (!active) return;
        setComputer(value);
        setMachineLabel(value.machine.label);
      })
      .catch(
        (error) =>
          active &&
          setPermissionError(clientErrorMessage(error, "Could not load computer settings"))
      );
    return () => {
      active = false;
    };
  }, []);

  const saveMachineLabel = () => {
    const label = machineLabel.trim();
    if (!computer || !label || label === computer.machine.label) return;
    setPermissionError(null);
    void window.openteam?.computer
      .update({ machineLabel: label })
      .then((value) => {
        setComputer(value);
        setMachineLabel(value.machine.label);
      })
      .catch((error) =>
        setPermissionError(clientErrorMessage(error, "Could not update computer settings"))
      );
  };

  return (
    <>
      <SectionLabel>Your computer</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Current computer"
          description="This is the computer you are using now"
          anchors={["computers"]}
          stackControl
          control={
            !computer && !permissionError ? (
              <div
                aria-label="Loading computer settings"
                className="flex items-center gap-2"
                role="status"
              >
                <SkeletonControl width={184} />
                <SkeletonControl width={50} />
              </div>
            ) : (
              <SettingsReveal as="div" className="flex min-w-0 items-center gap-2">
                <Input
                  aria-label="Computer label"
                  className={`${settingsInput} w-[184px] flex-1`}
                  maxLength={80}
                  onChange={(event) => setMachineLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveMachineLabel();
                  }}
                  value={machineLabel}
                />
                <Button
                  size="xs"
                  variant="secondary"
                  className={settingsSecondaryButton}
                  disabled={
                    !computer ||
                    !machineLabel.trim() ||
                    machineLabel.trim() === computer.machine.label
                  }
                  onClick={saveMachineLabel}
                  type="button"
                >
                  Save
                </Button>
              </SettingsReveal>
            )
          }
        />
      </SettingsGroup>
      {computer ? (
        <MessagesSettings computer={computer} onComputerChange={setComputer} />
      ) : !permissionError && window.openteam?.platform === "darwin" ? (
        // Messages is a Mac feature; hold its first row while the settings load.
        <>
          <SectionLabel>Messages</SectionLabel>
          <SettingsGroup>
            <SettingsRow
              title="Use Messages"
              description="Lets OpenTeam read and send texts on this Mac"
              control={<SkeletonSwitch />}
            />
          </SettingsGroup>
        </>
      ) : null}
      {permissionError ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400">
          {permissionError}
        </div>
      ) : null}
    </>
  );
}
