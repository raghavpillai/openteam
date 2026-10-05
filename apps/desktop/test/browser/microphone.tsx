import React from "react";
import { createRoot } from "react-dom/client";
import { renderMicrophoneControl } from "../../src/renderer/components/openteam/settings/general";
import { MicrophoneSettings } from "../../src/renderer/components/openteam/settings/microphone";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { api } from "../../src/renderer/client/openteam-api";
import { MICROPHONE_STORAGE_KEY } from "../../src/renderer/lib/microphone";

const root = createRoot(document.getElementById("root")!);
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const waitFor = async (check: () => boolean, label: string, timeout = 4000) => {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`${label}: ${document.body.textContent}`);
    await pause();
  }
};
const usb = { deviceId: "usb-mic", kind: "audioinput", label: "USB Microphone" } as MediaDeviceInfo;
const headset = {
  deviceId: "headset",
  kind: "audioinput",
  label: "Headset Microphone",
} as MediaDeviceInfo;
let devices: MediaDeviceInfo[] = [
  usb,
  headset,
  { deviceId: "speaker", kind: "audiooutput", label: "Speakers" } as MediaDeviceInfo,
];
let enumerate: () => Promise<MediaDeviceInfo[]> = async () => devices;
const requests: MediaStreamConstraints[] = [];
const active = new Set<MediaStreamTrack>();
let uploads = 0;
api.transcribeAudio = async () => {
  uploads++;
  return { text: "Microphone choice works." };
};
const synthesize = async () => {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.1;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  await context.resume();
  const track = destination.stream.getTracks()[0]!;
  active.add(track);
  const stop = track.stop.bind(track);
  track.stop = () => {
    if (!active.delete(track)) return;
    stop();
    oscillator.stop();
    void context.close();
  };
  return destination.stream;
};
let capture: (constraints: MediaStreamConstraints) => Promise<MediaStream> = synthesize;
const media = Object.assign(new EventTarget(), {
  enumerateDevices: () => enumerate(),
  getUserMedia: (constraints: MediaStreamConstraints) => {
    requests.push(constraints);
    return capture(constraints);
  },
});
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
let systemPermission = "not-determined";
let permissionRequests = 0;
let settingsOpened = 0;
let nativeStatusFails = false;
Object.defineProperty(window, "openteam", {
  configurable: true,
  value: {
    microphone: {
      status: async () => {
        if (nativeStatusFails) throw new Error("Native status unavailable");
        return { permission: systemPermission, canOpenSettings: true, canRequestPermission: true };
      },
      requestPermission: async () => {
        permissionRequests++;
        systemPermission = "granted";
        return true;
      },
      openSettings: async () => {
        settingsOpened++;
      },
    },
  },
});
// Chromium permission can disagree with the OS; the native result must take precedence.
Object.defineProperty(navigator, "permissions", {
  configurable: true,
  value: { query: async () => Object.assign(new EventTarget(), { state: "granted" }) },
});
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text || item.getAttribute("aria-label") === text
  )!;
const selector = () => document.querySelector<HTMLSelectElement>('[aria-label="Microphone"]')!;
const choose = async (id: string) => {
  selector().value = id;
  selector().dispatchEvent(new Event("change", { bubbles: true }));
  await pause();
};
const renderSettings = async (preview = false) => {
  root.render(
    <React.StrictMode>
      <MicrophoneSettings
        renderControl={
          preview
            ? renderMicrophoneControl
            : ({ options, onValueChange, ...props }) => (
                <select
                  aria-label="Microphone"
                  {...props}
                  onChange={(event) => onValueChange(event.target.value)}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )
        }
      />
    </React.StrictMode>
  );
  await waitFor(
    () =>
      preview
        ? Boolean(document.querySelector('[aria-label="Microphone"]'))
        : Boolean(selector()?.querySelector('option[value="headset"]')),
    "Device list"
  );
};
const unmount = async () => {
  root.render(null);
  await pause();
};

async function run() {
  const reports: string[] = [];
  localStorage.removeItem(MICROPHONE_STORAGE_KEY);
  await renderSettings();
  assert(requests.length === 0, "Opening settings accessed microphone");
  await waitFor(
    () => document.body.textContent!.includes("Not requested"),
    "OS permission not requested"
  );
  assert(permissionRequests === 0, "Opening settings requested system permission");
  button("Enable microphone").click();
  await waitFor(
    () => document.body.textContent!.includes("Allowed"),
    "Permission allowed after enable"
  );
  assert(
    permissionRequests === 1 && requests.length === 0,
    "Enable did not request OS permission without capture"
  );
  systemPermission = "denied";
  window.dispatchEvent(new Event("focus"));
  await waitFor(
    () => document.body.textContent!.includes("Blocked"),
    "Native denied overrides browser granted"
  );
  button("System settings").click();
  await pause();
  assert(
    settingsOpened === 1 && requests.length === 0,
    "Settings action accessed microphone or failed to open settings"
  );
  systemPermission = "restricted";
  window.dispatchEvent(new Event("focus"));
  await pause();
  assert(
    document.body.textContent!.includes("Blocked"),
    "Restricted OS access was shown as allowed"
  );
  systemPermission = "granted";
  window.dispatchEvent(new Event("focus"));
  await waitFor(
    () => document.body.textContent!.includes("Allowed"),
    "Refresh permission on return from system settings"
  );
  reports.push(
    "system permission status overrides browser permission, enables on click, and refreshes after returning from settings without capturing audio"
  );

  nativeStatusFails = true;
  window.dispatchEvent(new Event("focus"));
  await waitFor(
    () => document.body.textContent!.includes("Unknown"),
    "Failed native check must not report allowed"
  );
  const nativeBridge = (window as any).openteam.microphone;
  (window as any).openteam.microphone = undefined;
  window.dispatchEvent(new Event("focus"));
  await waitFor(
    () => document.body.textContent!.includes("Allowed"),
    "Browser permission fallback without native bridge"
  );
  assert(
    document.body.textContent!.includes("Allowed") && !button("System settings"),
    "Browser-only permission did not fall back to browser status"
  );
  (window as any).openteam.microphone = nativeBridge;
  nativeStatusFails = false;
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => Boolean(button("System settings")), "Native settings action recovered");
  reports.push(
    "failed OS permission checks stay unknown; browser-only sessions use browser status and native checks recover"
  );
  assert(selector().options.length === 3, "Outputs leaked into microphone choices");
  await choose("usb-mic");
  await unmount();
  await renderSettings();
  assert(selector().value === "usb-mic", "Selection did not survive remount");
  assert(
    localStorage.getItem(MICROPHONE_STORAGE_KEY) === "usb-mic",
    "Selection not persisted locally"
  );
  reports.push("settings enumerate inputs without recording and persist the choice on this client");

  devices = [headset];
  media.dispatchEvent(new Event("devicechange"));
  await waitFor(
    () => document.body.textContent!.includes("saved microphone is unavailable"),
    "Device removal"
  );
  assert(selector().value === "usb-mic", "Disconnect erased saved choice");
  devices = [usb, headset];
  media.dispatchEvent(new Event("devicechange"));
  await waitFor(
    () => selector().selectedOptions[0]?.textContent === "USB Microphone",
    "Device reconnect"
  );
  let finishOld!: (devices: MediaDeviceInfo[]) => void;
  enumerate = () =>
    new Promise((resolve) => {
      finishOld = resolve;
    });
  media.dispatchEvent(new Event("devicechange"));
  enumerate = async () => devices;
  media.dispatchEvent(new Event("devicechange"));
  await pause();
  finishOld([]);
  await pause();
  assert(selector().options.length === 3, "Stale device enumeration replaced current devices");
  reports.push("hot-plug refresh preserves the preferred microphone and ignores stale enumeration");

  localStorage.setItem(MICROPHONE_STORAGE_KEY, "headset");
  window.dispatchEvent(new StorageEvent("storage", { key: MICROPHONE_STORAGE_KEY }));
  await pause();
  assert(selector().value === "headset", "Preference did not sync across client windows");
  await choose("usb-mic");
  assert(
    requests.length === 0 && uploads === 0 && active.size === 0,
    "Settings captured or uploaded audio"
  );
  assert(
    !document.body.textContent!.includes("Microphone test"),
    "Removed microphone test is still shown"
  );
  reports.push("microphone selection syncs across windows without a test row or audio capture");

  await unmount();
  root.render(
    <PromptInput
      transcriptionConfigured
      onStage={async () => {
        throw new Error("No attachments");
      }}
      onSubmit={async () => undefined}
    />
  );
  await pause();
  capture = async (constraints) => {
    if ((constraints.audio as MediaTrackConstraints).deviceId)
      throw new DOMException("Disconnected", "NotFoundError");
    return synthesize();
  };
  document.querySelector<HTMLButtonElement>('[aria-label="Record voice note"]')!.click();
  await waitFor(() => Boolean(button("Stop recording")), "Voice recording");
  assert(
    document.body.textContent!.includes("Using system default"),
    "Composer fallback notice missing"
  );
  await pause(650);
  const waveform = [...document.querySelectorAll<HTMLElement>("[data-voice-waveform] > span")];
  assert(waveform.length === 5, "Recording waveform does not contain five spectrum bars");
  assert(
    waveform.some((bar) => bar.getBoundingClientRect().height > 3),
    "Waveform did not respond to the real synthetic audio stream"
  );
  button("Stop recording").click();
  await waitFor(
    () =>
      document.querySelector("[contenteditable]")!.textContent!.includes("Microphone choice works"),
    "Voice transcript"
  );
  assert(uploads === 1 && active.size === 0, "Recording did not upload once and release input");
  reports.push("actual MediaRecorder and composer use the saved microphone and fallback");

  capture = synthesize;
  document.querySelector<HTMLButtonElement>('[aria-label="Record voice note"]')!.click();
  await waitFor(() => Boolean(button("Stop recording")), "Second recording");
  await pause(650);
  [...active][0]!.dispatchEvent(new Event("ended"));
  await waitFor(
    () => document.body.textContent!.includes("Microphone disconnected"),
    "Recording disconnect error"
  );
  assert(
    uploads === 1 && active.size === 0,
    "Disconnected recording uploaded partial audio or leaked input"
  );
  reports.push(
    "losing the microphone stops recording with an error instead of uploading partial audio"
  );
  await unmount();
  await renderSettings();
  (window as any).voiceScreenshotStates = [
    "microphone-not-requested",
    "microphone-blocked",
    "microphone-allowed",
    "microphone-blocked-narrow",
    "microphone-allowed-dark",
  ];
  (window as any).prepareVoiceScreenshot = async (state: string) => {
    await unmount();
    systemPermission = state.includes("not-requested")
      ? "not-determined"
      : state.includes("blocked")
        ? "denied"
        : "granted";
    document.documentElement.dataset.theme = state.includes("dark") ? "dark" : "light";
    document.body.style.maxWidth = state.includes("narrow") ? "500px" : "800px";
    await renderSettings(true);
    await waitFor(
      () =>
        Boolean(document.querySelector('[role="status"]')) &&
        !document.body.textContent!.includes("Checking…"),
      "Screenshot permission ready"
    );
  };
  (window as any).finishVoiceScreenshot = unmount;
  return { reports, uploads };
}
run()
  .then((result) => {
    (window as any).voiceResults = result;
  })
  .catch((error) => {
    (window as any).voiceResults = { error: error.message, stack: error.stack };
  });
