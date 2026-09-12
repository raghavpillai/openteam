import { useState } from "react";
import { useMicrophoneDevices } from "../../../hooks/use-microphone-devices";
import { useMicrophoneTest } from "../../../hooks/use-microphone-test";
import { setMicrophonePreference } from "../../../lib/microphone";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export function MicrophoneSettings() {
  const { deviceId, devices, status, permission } = useMicrophoneDevices();
  const test = useMicrophoneTest(deviceId);
  const [saveError, setSaveError] = useState("");
  const missing =
    deviceId && status === "ready" && !devices.some((device) => device.deviceId === deviceId);
  const availability =
    permission === "denied"
      ? "Microphone access is blocked. Allow OpenTeam in system settings, then try again."
      : status === "unsupported"
        ? "Microphone input is unavailable in this app environment."
        : status === "error"
          ? "Could not list microphones. Use Test microphone to check access."
          : missing
            ? "Your saved microphone is unavailable. Recording will try the system default until it reconnects."
            : status === "ready" && devices.length === 0
              ? "No microphones are visible. Connect a microphone or use Test microphone to check access."
              : "Choose the microphone for this computer. Your other devices keep their own selection.";
  const active = test.state !== "idle";
  return (
    <>
      <SectionLabel>System</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Microphone"
          anchors={["microphone"]}
          description={availability}
          control={
            <select
              aria-label="Microphone"
              className="h-8 max-w-[220px] rounded-[8px] border border-black/[0.055] bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/[0.07]"
              disabled={status === "unsupported"}
              value={deviceId}
              onChange={(event) => {
                try {
                  setMicrophonePreference(event.target.value);
                  setSaveError("");
                } catch {
                  setSaveError(
                    "Could not save your microphone choice. Check local app storage and try again."
                  );
                }
              }}
            >
              <option value="">System Default</option>
              {deviceId && !devices.some((device) => device.deviceId === deviceId) ? (
                <option value={deviceId}>Saved microphone (unavailable)</option>
              ) : null}
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="Test microphone"
          description="Check input for up to 30 seconds. Audio stays on this computer and is not recorded or uploaded."
          control={
            <button
              type="button"
              className="h-8 rounded-full bg-black/[0.06] px-3 text-[12px] outline-none hover:bg-black/[0.1] focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-40 dark:bg-white/[0.08] dark:hover:bg-white/[0.12]"
              disabled={status === "unsupported"}
              onClick={active ? test.stop : test.start}
            >
              {test.state === "requesting"
                ? "Cancel microphone test"
                : active
                  ? "Stop microphone test"
                  : "Test microphone"}
            </button>
          }
        />
        {active || test.message || saveError ? (
          <div className="space-y-2 border-t border-black/[0.065] py-3 dark:border-white/[0.07]">
            {test.state === "testing" ? (
              <div
                role="meter"
                aria-label="Microphone input level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(test.level * 100)}
                className="h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
              >
                <div
                  className="h-full rounded-full bg-foreground transition-[width] duration-100"
                  style={{ width: `${test.level * 100}%` }}
                />
              </div>
            ) : null}
            <p role="status" className="text-[12px] text-foreground-secondary">
              {saveError ||
                (test.state === "requesting" ? "Waiting for microphone permission…" : test.message)}
            </p>
          </div>
        ) : null}
      </SettingsGroup>
    </>
  );
}
