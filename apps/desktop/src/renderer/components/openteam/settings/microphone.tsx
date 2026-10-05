import { type ReactNode, useState } from "react";
import { useMicrophoneDevices } from "../../../hooks/use-microphone-devices";
import { microphoneErrorMessage, setMicrophonePreference } from "../../../lib/microphone";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export interface MicrophoneControlProps {
  disabled: boolean;
  value: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
}

const actionClass =
  "inline-flex h-7 items-center rounded-[8px] border border-black/[0.055] bg-black/[0.035] px-2.5 text-[12px] hover:bg-black/[0.065] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 dark:border-white/[0.07] dark:bg-white/[0.07] dark:hover:bg-white/[0.1]";

export function MicrophoneSettings({
  renderControl,
}: {
  renderControl: (props: MicrophoneControlProps) => ReactNode;
}) {
  const {
    deviceId,
    devices,
    status,
    permission,
    checking,
    canOpenSettings,
    enable,
    openSettings,
    refresh,
  } = useMicrophoneDevices();
  const [saveError, setSaveError] = useState("");
  const [accessError, setAccessError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const accessLabel = checking
    ? "Checking…"
    : permission === "granted"
      ? "Allowed"
      : permission === "denied"
        ? "Blocked"
        : permission === "prompt"
          ? "Not requested"
          : "Unknown";
  const requestAccess = async () => {
    setAccessError("");
    setRequesting(true);
    try {
      await enable();
    } catch (error) {
      setAccessError(microphoneErrorMessage(error));
    } finally {
      setRequesting(false);
    }
  };
  const showSystemSettings = async () => {
    setAccessError("");
    try {
      await openSettings();
    } catch {
      setAccessError(
        "Could not open system settings. Open your device’s microphone privacy settings."
      );
    }
  };
  const missing = Boolean(deviceId && !devices.some((device) => device.deviceId === deviceId));
  const availability =
    status === "unsupported"
      ? "Microphone input is unavailable in this app environment."
      : status === "error"
        ? "Could not list microphones."
        : permission === "granted" && status === "ready" && devices.length === 0
          ? "No microphone found. Connect a microphone to record voice notes."
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
              ...devices.map((device, index) => ({
                value: device.deviceId,
                label: device.label || `Microphone ${index + 1}`,
              })),
            ],
            onValueChange: (value) => {
              try {
                setMicrophonePreference(value === "system-default" ? "" : value);
                setSaveError("");
              } catch {
                setSaveError(
                  "Could not save your microphone choice. Check local app storage and try again."
                );
              }
            },
          })}
        />
        <SettingsRow
          title="Microphone access"
          description={
            accessError ||
            (permission === "denied"
              ? canOpenSettings
                ? "Allow OpenTeam in system settings."
                : "Allow microphone access in your browser’s site settings."
              : permission === "prompt"
                ? "Allow microphone access to record voice notes."
                : permission === "unknown" && !checking
                  ? "Microphone permission could not be checked."
                  : undefined)
          }
          control={
            <div className="flex items-center gap-3">
              <span
                aria-label={`Microphone access ${accessLabel.toLowerCase()}`}
                className="inline-flex items-center gap-1.5 text-[12px] text-foreground-secondary"
                role="status"
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${permission === "granted" && !checking ? "bg-emerald-500" : "bg-foreground-tertiary"}`}
                />
                {accessLabel}
              </span>
              {!checking && (permission === "prompt" || permission === "unknown") ? (
                <button
                  className={actionClass}
                  disabled={requesting || status === "unsupported"}
                  onClick={() => void requestAccess()}
                  type="button"
                >
                  {requesting ? "Requesting…" : "Enable microphone"}
                </button>
              ) : !checking && canOpenSettings ? (
                <button
                  className={actionClass}
                  onClick={() => void showSystemSettings()}
                  type="button"
                >
                  System settings
                </button>
              ) : !checking && permission === "denied" ? (
                <button className={actionClass} onClick={() => void refresh()} type="button">
                  Check again
                </button>
              ) : null}
            </div>
          }
        />
      </SettingsGroup>
    </>
  );
}
