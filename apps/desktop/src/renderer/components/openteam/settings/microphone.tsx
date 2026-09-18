import { type ReactNode, useState } from "react";
import { useMicrophoneDevices } from "../../../hooks/use-microphone-devices";
import { setMicrophonePreference } from "../../../lib/microphone";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export interface MicrophoneControlProps {
  disabled: boolean;
  value: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
}

export function MicrophoneSettings({ renderControl }: { renderControl: (props: MicrophoneControlProps) => ReactNode }) {
  const { deviceId, devices, status, permission } = useMicrophoneDevices();
  const [saveError, setSaveError] = useState("");
  const missing = Boolean(deviceId && !devices.some((device) => device.deviceId === deviceId));
  const availability = permission === "denied"
    ? "Microphone access is blocked. Allow OpenTeam in system settings."
    : status === "unsupported"
      ? "Microphone input is unavailable in this app environment."
      : status === "error"
        ? "Could not list microphones."
        : missing && status === "ready"
          ? "Your saved microphone is unavailable. Recording will use the system default until it reconnects."
          : undefined;
  return (
    <>
      <SectionLabel>System</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Microphone"
          anchors={["microphone"]}
          description={saveError || availability}
          control={renderControl({
            disabled: status === "unsupported",
            value: deviceId || "system-default",
            options: [
              { value: "system-default", label: "System Default" },
              ...(missing ? [{ value: deviceId, label: "Saved microphone (unavailable)" }] : []),
              ...devices.map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
            ],
            onValueChange: (value) => {
              try {
                setMicrophonePreference(value === "system-default" ? "" : value);
                setSaveError("");
              } catch {
                setSaveError("Could not save your microphone choice. Check local app storage and try again.");
              }
            },
          })}
        />
      </SettingsGroup>
    </>
  );
}
