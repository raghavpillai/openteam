import { useEffect, useState } from "react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import {
  SectionLabel,
  SettingsGroup,
  SettingsRow,
  settingsInput,
  settingsSecondaryButton,
} from "./ui";
import { MessagesSettings } from "./messages";

export default function ComputerSettings() {
  const [computer, setComputer] = useState<OpenTeamComputerSettings | null>(null);
  const [machineLabel, setMachineLabel] = useState("");
  const [permissionError, setPermissionError] = useState<string | null>(null);

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
            <div className="flex min-w-0 items-center gap-2">
              <input
                aria-label="Computer label"
                className={`${settingsInput} w-[184px] flex-1`}
                maxLength={80}
                onChange={(event) => setMachineLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveMachineLabel();
                }}
                value={machineLabel}
              />
              <button
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
              </button>
            </div>
          }
        />
      </SettingsGroup>
      {computer ? <MessagesSettings computer={computer} onComputerChange={setComputer} /> : null}
      {permissionError ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400">
          {permissionError}
        </div>
      ) : null}
    </>
  );
}
