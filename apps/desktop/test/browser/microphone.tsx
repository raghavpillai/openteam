import React from "react";
import { createRoot } from "react-dom/client";
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
const renderSettings = async () => {
  root.render(
    <React.StrictMode>
      <MicrophoneSettings />
    </React.StrictMode>
  );
  await waitFor(() => Boolean(selector()?.querySelector('option[value="headset"]')), "Device list");
};
const unmount = async () => {
  root.render(null);
  await pause();
};
const startTest = async () => {
  button("Test microphone").click();
  await waitFor(() => Boolean(document.querySelector('[role="meter"]')), "Microphone test started");
};

async function run() {
  const reports: string[] = [];
  localStorage.removeItem(MICROPHONE_STORAGE_KEY);
  await renderSettings();
  assert(requests.length === 0, "Opening settings accessed microphone");
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

  await startTest();
  await waitFor(
    () => Number(document.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")) > 10,
    "Real audio level"
  );
  assert(
    (requests.at(-1)!.audio as MediaTrackConstraints).deviceId &&
      JSON.stringify(requests.at(-1)).includes("usb-mic"),
    "Test ignored selected input"
  );
  assert(uploads === 0, "Microphone test uploaded audio");
  button("Stop microphone test").click();
  await waitFor(() => active.size === 0, "Stop releases microphone");
  reports.push(
    "local test uses the chosen microphone and real Web Audio metering without uploading"
  );

  await startTest();
  await choose("headset");
  assert(active.size === 0, "Changing device left previous test running");
  await startTest();
  await unmount();
  assert(active.size === 0, "Closing settings leaked microphone");
  await renderSettings();
  localStorage.setItem(MICROPHONE_STORAGE_KEY, "usb-mic");
  window.dispatchEvent(new StorageEvent("storage", { key: MICROPHONE_STORAGE_KEY }));
  await pause();
  assert(selector().value === "usb-mic", "Preference did not sync across client windows");
  reports.push(
    "device changes, closing settings, and client-window preference updates release tests"
  );

  let resolvePermission!: (stream: MediaStream) => void;
  capture = () =>
    new Promise((resolve) => {
      resolvePermission = resolve;
    });
  button("Test microphone").click();
  await waitFor(
    () => Boolean(button("Cancel microphone test")),
    "Pending permission can be cancelled"
  );
  button("Cancel microphone test").click();
  resolvePermission(await synthesize());
  await pause();
  assert(
    active.size === 0 && !document.querySelector('[role="meter"]'),
    "Cancelled permission started a test"
  );
  reports.push("cancelling an unanswered permission request releases its late audio stream");

  const beforeDenied = requests.length;
  capture = async () => {
    throw new DOMException("Denied", "NotAllowedError");
  };
  button("Test microphone").click();
  await waitFor(
    () => document.body.textContent!.includes("Allow microphone access"),
    "Denied message"
  );
  assert(requests.length === beforeDenied + 1, "Permission denial retried another input");
  capture = async () => {
    throw new DOMException("Missing", "NotFoundError");
  };
  button("Test microphone").click();
  await waitFor(
    () => document.body.textContent!.includes("No microphone found"),
    "Missing microphone message"
  );
  reports.push("permission denial and missing hardware produce distinct actionable errors");

  capture = async (constraints) => {
    if ((constraints.audio as MediaTrackConstraints).deviceId)
      throw new DOMException("Disconnected", "NotReadableError");
    return synthesize();
  };
  await startTest();
  assert(document.body.textContent!.includes("Using system default"), "Fallback notice missing");
  assert(
    !JSON.stringify(requests.at(-1)).includes("deviceId"),
    "Fallback still requested missing device"
  );
  assert(selector().value === "usb-mic", "Fallback forgot preferred microphone");
  [...active][0]!.dispatchEvent(new Event("ended"));
  await waitFor(
    () => active.size === 0 && document.body.textContent!.includes("Microphone disconnected"),
    "Disconnected test cleanup"
  );
  reports.push("unavailable selection falls back once and a disconnected test releases its audio");

  capture = synthesize;
  await startTest();
  await waitFor(
    () => document.body.textContent!.includes("Microphone test finished"),
    "Automatic 30-second stop",
    32_000
  );
  assert(active.size === 0 && uploads === 0, "Automatic stop leaked audio or uploaded the test");
  reports.push("microphone tests automatically stop after 30 seconds");

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
  reports.push(
    "actual MediaRecorder and composer share saved selection and fallback with the microphone test"
  );

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
  (window as any).prepareMicrophoneScreenshot = async () => {
    await startTest();
    await waitFor(
      () => Number(document.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")) > 10,
      "Screenshot level"
    );
  };
  (window as any).finishMicrophoneScreenshot = unmount;
  return { reports, uploads };
}
run()
  .then((result) => {
    (window as any).voiceResults = result;
  })
  .catch((error) => {
    (window as any).voiceResults = { error: error.message, stack: error.stack };
  });
