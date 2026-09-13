import React from "react";
import { createRoot } from "react-dom/client";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { api } from "../../src/renderer/client/openteam-api";
import { signIn } from "../../src/renderer/client/auth";
import { desktopDurableSendController } from "../../src/renderer/lib/durable-sends";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const root = createRoot(document.getElementById("root")!);
const waitFor = async (predicate: () => boolean, label: string, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}: ${document.body.textContent}`);
    await pause(50);
  }
};
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
let uploads = 0;
let attachmentUploads = 0;
// Count actual requests without replacing MediaRecorder or the API.
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
  if (path === "/api/v0/transcriptions") uploads++;
  if (path === "/api/v0/assets") attachmentUploads++;
  return nativeFetch(input, init);
};

(window as any).runVoiceLive = async (credentials: {
  username: string;
  password: string;
  audioBase64: string;
}) => {
  const reports: string[] = [];
  // Chromium's audio utility sandbox cannot open arbitrary test WAV paths on
  // macOS. Feed the fixture through Web Audio, preserving the actual permission
  // request, MediaStream tracks, MediaRecorder encoding and network transport.
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const device = await getUserMedia(constraints);
    device.getTracks().forEach((track) => track.stop());
    const context = new AudioContext();
    const buffer = await context.decodeAudioData(
      Uint8Array.from(atob(credentials.audioBase64), (character) => character.charCodeAt(0)).buffer
    );
    const source = context.createBufferSource();
    source.buffer = buffer;
    const output = context.createMediaStreamDestination();
    source.connect(output);
    await context.resume();
    source.start();
    const track = output.stream.getAudioTracks()[0]!;
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      source.stop();
      void context.close();
    };
    return output.stream;
  };
  console.log("Signing in");
  await signIn(credentials.username, credentials.password);
  console.log("Signed in");
  const saved = await api.transcriptionSettings();
  const bot = await api.createBot({
    name: "Desktop Voice QA",
    clientRequestId: crypto.randomUUID(),
  });
  const sends = desktopDurableSendController();
  await sends.restore();
  let submitted = 0;
  let clientId = "";
  const render = async () => {
    const { runtime } = await api.runtime();
    root.render(
      <PromptInput
        transcriptionConfigured={runtime.transcription === "configured"}
        onStage={async () => {
          throw new Error("Unexpected attachment");
        }}
        onSubmit={async (content, attachments, options) => {
          submitted++;
          const sent = await sends.enqueue({
            target: { channelId: bot.dmChannelId, conversationId: bot.conversationId },
            payload: { content, attachments, richText: options?.richText },
          });
          clientId = sent.nonce;
        }}
      />
    );
    await pause(80);
  };
  await api.updateTranscriptionSettings({ ...saved, enabled: false });
  await pause(2100);
  await render();
  assert(
    button("Set up transcription in Server settings to use voice notes")?.disabled,
    "Unconfigured microphone is enabled"
  );
  reports.push("server runtime disables the microphone when transcription is off");
  await api.updateTranscriptionSettings({ ...saved, enabled: true });
  await pause(2100);
  await render();
  assert(button("Record voice note")?.disabled === false, "Configured microphone is disabled");
  button("Record voice note")!.click();
  console.log("Requested recording");
  await waitFor(() => Boolean(button("Stop recording")), "real microphone recording");
  await pause(4500);
  assert(uploads === 0, "Recording streamed audio before Stop");
  const start = performance.now();
  button("Stop recording")!.click();
  console.log("Stopped recording, waiting for transcript");
  await waitFor(
    () =>
      document
        .querySelector("[contenteditable]")
        ?.textContent?.toLowerCase()
        .includes("project update") ?? false,
    "Parakeet transcript",
    120_000
  );
  const transcript = document.querySelector("[contenteditable]")!.textContent;
  await waitFor(
    () =>
      button("Send message")?.disabled === false &&
      !document.body.textContent?.includes("Transcribing"),
    "editable composer restored after transcription"
  );
  await pause(200);
  assert(uploads === 1, "Expected one completed voice note upload");
  assert(attachmentUploads === 0, "Voice note became an attachment");
  reports.push("real Chromium MediaRecorder → authenticated server → Parakeet → editable draft");
  const transcriptionMs = Math.round(performance.now() - start);
  assert(submitted === 0, "Stop sent the note before review");
  button("Send message")!.click();
  await waitFor(() => Boolean(clientId), "durable journal acceptance");
  await sends.flush();
  await waitFor(
    () =>
      sends
        .getSnapshot()
        .some((record) => record.nonce === clientId && record.phase === "accepted-awaiting-echo"),
    "server message acceptance"
  );
  assert(submitted === 1, "Review/send submitted the note more than once");
  reports.push("reviewed transcript → real durable send → authenticated chat route");
  (window as any).voiceLiveResults = {
    reports,
    transcript,
    transcriptionMs,
    deliveries: [{ botId: bot.id, clientId, text: transcript }],
    uploads,
    attachmentUploads,
  };
  return (window as any).voiceLiveResults;
};
