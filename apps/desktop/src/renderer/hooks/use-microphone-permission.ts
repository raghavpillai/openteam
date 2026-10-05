import { useEffect, useRef, useState } from "react";
import { MICROPHONE_ACCESS_EVENT, openMicrophone } from "../lib/microphone";

export function useMicrophonePermission() {
  const [permission, setPermission] = useState<PermissionState | "unknown">("unknown");
  const [checking, setChecking] = useState(true);
  const [canOpenSettings, setCanOpenSettings] = useState(false);
  const [canRequestPermission, setCanRequestPermission] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    let sequence = 0;
    let browserPermission: PermissionStatus | undefined;
    const check = async () => {
      const session = ++sequence;
      try {
        const native = await window.openteam?.microphone?.status();
        if (!active || session !== sequence) return;
        setCanOpenSettings(native?.canOpenSettings ?? false);
        setCanRequestPermission(native?.canRequestPermission ?? false);
        let value: PermissionState | "unknown" = "unknown";
        if (native && native.permission !== "unknown") {
          value =
            native.permission === "granted"
              ? "granted"
              : native.permission === "not-determined"
                ? "prompt"
                : "denied";
        } else if (browserPermission) {
          value = browserPermission.state;
        } else {
          const queried = await navigator.permissions?.query({
            name: "microphone" as PermissionName,
          });
          if (!active || session !== sequence) return;
          browserPermission = queried;
          browserPermission?.addEventListener("change", onChange);
          value = browserPermission?.state ?? "unknown";
        }
        if (!active || session !== sequence) return;
        setPermission(value);
      } catch {
        if (active && session === sequence) {
          setPermission("unknown");
          setCanOpenSettings(false);
          setCanRequestPermission(false);
        }
      } finally {
        if (active && session === sequence) setChecking(false);
      }
    };
    const onChange = () => {
      void check();
    };
    refresh.current = check;
    void check();
    window.addEventListener("focus", onChange);
    window.addEventListener(MICROPHONE_ACCESS_EVENT, onChange);
    return () => {
      active = false;
      request.current?.abort();
      browserPermission?.removeEventListener("change", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener(MICROPHONE_ACCESS_EVENT, onChange);
    };
  }, []);

  const enable = async () => {
    const abort = new AbortController();
    request.current = abort;
    try {
      if (canRequestPermission) {
        await window.openteam!.microphone.requestPermission();
        if (!abort.signal.aborted) window.dispatchEvent(new Event(MICROPHONE_ACCESS_EVENT));
      } else {
        const { stream } = await openMicrophone({ signal: abort.signal });
        stream.getTracks().forEach((track) => track.stop());
      }
    } finally {
      if (!abort.signal.aborted) await refresh.current();
    }
  };

  return {
    permission,
    checking,
    canOpenSettings,
    enable,
    refresh: () => refresh.current(),
    openSettings: () => window.openteam!.microphone.openSettings(),
  };
}
