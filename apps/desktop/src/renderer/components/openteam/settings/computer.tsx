import { useEffect, useState } from "react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { SectionLabel, SettingsGroup } from "./ui";
import { MachineSettings } from "./machines";

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
      <SectionLabel>Computers</SectionLabel>
      <SettingsGroup>
        <div
          className="flex min-h-[52px] items-center gap-5 py-1.5"
          data-settings-anchor="computers"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-[17px] text-foreground">Current computer</div>
            <div className="mt-px text-[12px] leading-4 text-foreground-secondary">
              This is the computer you are using now
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <input
              aria-label="Computer label"
              className="h-8 w-[184px] rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/[0.1]"
              maxLength={80}
              onChange={(event) => setMachineLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveMachineLabel();
              }}
              value={machineLabel}
            />
            <button
              className="inline-flex h-8 items-center rounded-[8px] bg-black/[0.08] px-3 text-[12px] text-foreground disabled:text-foreground-tertiary dark:bg-white/[0.09]"
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
        </div>
      </SettingsGroup>
      <MachineSettings />
      {permissionError ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400">
          {permissionError}
        </div>
      ) : null}
    </>
  );
}
