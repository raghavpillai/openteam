import { useEffect, useState } from "react";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionLabel, SettingsGroup, SettingsRow } from "./settings-ui";

export default function ComputerSettings() {
  const [permissions, setPermissions] = useState<OpenBotPermissionSettings | null>(null);
  const [machineLabel, setMachineLabel] = useState("");
  const [permissionError, setPermissionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.openbot?.permissions
      .get()
      .then((value) => {
        if (!active) return;
        setPermissions(value);
        setMachineLabel(value.machine.label);
      })
      .catch(
        (error) =>
          active &&
          setPermissionError(clientErrorMessage(error, "Could not load computer permissions"))
      );
    return () => {
      active = false;
    };
  }, []);

  const updatePermission = (
    localToolPermission: OpenBotPermissionSettings["localToolPermission"]
  ) => {
    setPermissionError(null);
    void window.openbot?.permissions
      .update({ localToolPermission })
      .then(setPermissions)
      .catch((error) =>
        setPermissionError(clientErrorMessage(error, "Could not update computer permissions"))
      );
  };

  const saveMachineLabel = () => {
    const label = machineLabel.trim();
    if (!permissions || !label || label === permissions.machine.label) return;
    setPermissionError(null);
    void window.openbot?.permissions
      .update({ machineLabel: label })
      .then((value) => {
        setPermissions(value);
        setMachineLabel(value.machine.label);
      })
      .catch((error) =>
        setPermissionError(clientErrorMessage(error, "Could not update computer permissions"))
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
                !permissions ||
                !machineLabel.trim() ||
                machineLabel.trim() === permissions.machine.label
              }
              onClick={saveMachineLabel}
              type="button"
            >
              Save
            </button>
          </div>
        </div>
        <SettingsRow
          anchors={["local-execution"]}
          control={
            <Select
              disabled={!permissions}
              onValueChange={(value) =>
                updatePermission(value as OpenBotPermissionSettings["localToolPermission"])
              }
              value={permissions?.localToolPermission ?? "ask"}
            >
              <SelectTrigger
                aria-label="Execution on this computer"
                className="h-7 rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Ask every time</SelectItem>
                <SelectItem value="always">Always allow</SelectItem>
                <SelectItem value="never">Never allow</SelectItem>
              </SelectContent>
            </Select>
          }
          description="Let OpenBot open files and run tasks on your computer. Auto-review still checks everything first."
          title="Execution on this computer"
        />
      </SettingsGroup>
      {permissionError ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400">
          {permissionError}
        </div>
      ) : null}
    </>
  );
}
