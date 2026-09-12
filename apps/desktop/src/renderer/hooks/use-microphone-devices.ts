import { useEffect, useState, useSyncExternalStore } from "react";
import {
  MICROPHONE_ACCESS_EVENT,
  readMicrophonePreference,
  subscribeMicrophonePreference,
} from "../lib/microphone";

export function useMicrophoneDevices() {
  const deviceId = useSyncExternalStore(subscribeMicrophonePreference, readMicrophonePreference);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [permission, setPermission] = useState<PermissionState | "unknown">("unknown");
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) {
      setStatus("unsupported");
      return;
    }
    let active = true;
    let sequence = 0;
    let permissionStatus: PermissionStatus | undefined;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const all = await media.enumerateDevices();
        if (!active || request !== sequence) return;
        setDevices(
          all.filter(
            (device) =>
              device.kind === "audioinput" && device.deviceId && device.deviceId !== "default"
          )
        );
        setStatus("ready");
      } catch {
        if (active && request === sequence) setStatus("error");
      }
    };
    const permissionChanged = () => {
      if (!active || !permissionStatus) return;
      setPermission(permissionStatus.state);
      void refresh();
    };
    // Querying permission does not request it or activate the microphone.
    void navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((value) => {
        if (!active) return;
        permissionStatus = value;
        permissionChanged();
        value.addEventListener("change", permissionChanged);
      })
      .catch(() => undefined);
    void refresh();
    media.addEventListener("devicechange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(MICROPHONE_ACCESS_EVENT, refresh);
    return () => {
      active = false;
      media.removeEventListener("devicechange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(MICROPHONE_ACCESS_EVENT, refresh);
      permissionStatus?.removeEventListener("change", permissionChanged);
    };
  }, []);
  return { deviceId, devices, status, permission };
}
