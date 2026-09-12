import React from "react";
import { createRoot } from "react-dom/client";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { api } from "../../src/renderer/client/openteam-api";
import { TranscriptionSettingsPanel } from "../../src/renderer/components/openteam/settings/transcription";
import { defaultTranscriptionSettings } from "@openteam/contracts/transcription";

const renderErrors: string[] = [];
const root = createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => {
    renderErrors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  },
});
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const waitFor = async (condition: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await pause();
  }
  throw new Error(
    `${message}: ${document.body.textContent?.slice(0, 600)} ${renderErrors.join("\n")} ${JSON.stringify({ uploads, transcripts, editor: document.querySelector("[contenteditable]")?.outerHTML })}`
  );
};
let stoppedTracks = 0;
let requested = 0;
let uploads = 0;
let transcripts: string[] = [];
let upload: (audio: Blob, signal?: AbortSignal) => Promise<{ text: string }> = async () => ({
  text: "Ship it tomorrow.",
});
let media: () => Promise<MediaStream> = async () =>
  ({
    getTracks: () => [
      Object.assign(new EventTarget(), {
        stop: () => {
          stoppedTracks++;
        },
      }),
    ],
  }) as unknown as MediaStream;
Object.defineProperty(navigator, "mediaDevices", {
  value: {
    getUserMedia: () => {
      requested++;
      return media();
    },
  },
  configurable: true,
});
class Recorder {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(128)]) });
      this.onstop?.();
    }, 0);
  }
}
Object.defineProperty(window, "MediaRecorder", { value: Recorder, configurable: true });
api.transcribeAudio = async (audio, signal) => {
  uploads++;
  return upload(audio, signal);
};
const render = (enabled: boolean, key = "chat") =>
  root.render(
    <React.StrictMode>
      <PromptInput
        key={key}
        transcriptionConfigured={enabled}
        onStage={async () => {
          throw new Error("Voice notes must not become attachments");
        }}
        onSubmit={async (text) => {
          transcripts.push(text);
        }}
      />
    </React.StrictMode>
  );
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const textButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === label
  );
const record = async () => {
  button("Record voice note")!.click();
  await pause(600);
  button("Stop recording")!.click();
  await pause(80);
};

async function run() {
  const reports: string[] = [];
  render(false);
  await pause(80);
  const disabled = button("Set up transcription in Server settings to use voice notes")!;
  assert(disabled?.disabled, "Microphone must be disabled before setup");
  disabled.click();
  await pause();
  assert(requested === 0, "Disabled microphone requested access");
  reports.push("microphone disabled without transcription");
  render(true);
  await pause();
  const editor = document.querySelector<HTMLElement>("[contenteditable]")!;
  editor.innerHTML =
    '<span data-mention-id="bot-1" data-mention-label="Helper" data-mention-handle="helper" contenteditable="false">@Helper</span> existing draft';
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  const mention = editor.querySelector("span");
  await record();
  assert(
    editor.textContent?.endsWith("existing draft Ship it tomorrow."),
    "Transcript did not append to draft"
  );
  assert(editor.querySelector("span") === mention, "Transcription replaced mention token");
  assert(stoppedTracks === 1, "Microphone track not released after stop");
  button("Send message")!.click();
  await pause();
  assert(
    transcripts.length === 1 && transcripts[0]!.includes("Ship it tomorrow."),
    "Submitted content missed transcript"
  );
  reports.push("record, append with mentions, stop microphone, and submit");

  upload = async () => {
    throw new Error("Provider offline");
  };
  await record();
  assert(document.body.textContent?.includes("Provider offline"), "Provider failure missing");
  assert(Boolean(textButton("Retry transcription")), "Failed recording cannot be retried");
  const beforeRetry = requested;
  upload = async () => ({ text: "Retry worked." });
  textButton("Retry transcription")!.click();
  await pause();
  assert(
    requested === beforeRetry && editor.textContent?.includes("Retry worked."),
    "Retry re-recorded or lost the audio"
  );
  reports.push("provider failure keeps audio for retry");

  let resolveUpload: ((value: { text: string }) => void) | undefined;
  let signal: AbortSignal | undefined;
  upload = async (_audio, nextSignal) => {
    signal = nextSignal;
    return new Promise((resolve) => {
      resolveUpload = resolve;
    });
  };
  await record();
  button("Cancel voice note")!.click();
  await pause();
  assert(signal?.aborted, "Cancel did not abort upload");
  resolveUpload!({ text: "Cancelled text" });
  await pause();
  assert(!editor.textContent?.includes("Cancelled text"), "Cancelled result edited draft");
  reports.push("cancellation aborts upload and discards late result");

  upload = async () => ({ text: "Send this voice memo." });
  const beforeSend = transcripts.length;
  button("Record voice note")!.click();
  await pause(600);
  button("Transcribe and send")!.click();
  await pause(100);
  assert(transcripts.length === beforeSend + 1, "Voice send did not submit exactly once");
  assert(transcripts.at(-1)?.includes("Send this voice memo."), "Voice send omitted transcript");
  reports.push("voice arrow transcribes and sends exactly once, including existing draft");

  const key = (key: string, type = "keydown", modifiers = {}) =>
    editor.dispatchEvent(
      new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...modifiers })
    );
  const shortcut = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  editor.focus();
  key("d", "keydown", shortcut);
  await pause(50);
  key("d", "keyup", shortcut);
  await pause(550);
  assert(Boolean(button("Stop recording")), "Tap shortcut did not keep recording");
  const beforeStop = transcripts.length;
  key("Enter");
  await waitFor(
    () => Boolean(editor.textContent?.includes("Send this voice memo.")),
    "Enter did not stop into draft"
  );
  assert(transcripts.length === beforeStop, "First Enter sent without review");
  key("d", "keydown", shortcut);
  await pause(600);
  key("d", "keyup", shortcut);
  await pause(100);
  assert(!button("Stop recording"), "Held shortcut did not stop on release");
  const beforeCancel = uploads;
  key("d", "keydown", shortcut);
  await pause(600);
  key("Escape");
  key("d", "keyup", shortcut);
  await pause(80);
  assert(uploads === beforeCancel && !button("Stop recording"), "Escape uploaded cancelled audio");
  reports.push("shortcut tap/hold, Enter to review, and Escape cancellation");

  upload = async () => {
    throw new Error("Voice send failed");
  };
  button("Record voice note")!.click();
  await pause(600);
  const failedSendCount = transcripts.length;
  button("Transcribe and send")!.click();
  await pause(80);
  upload = async () => ({ text: "Review the retry first." });
  textButton("Retry transcription")!.click();
  await pause(100);
  assert(
    transcripts.length === failedSendCount,
    "Retry unexpectedly sent a previously failed memo"
  );
  assert(editor.textContent?.includes("Review the retry first."), "Retry lost the draft");
  reports.push("failed voice send retries into the draft without an unexpected send");

  upload = async (_audio, nextSignal) => {
    signal = nextSignal;
    return new Promise((resolve) => {
      resolveUpload = resolve;
    });
  };
  await record();
  assert(
    document.activeElement === editor,
    "Stopping with the pill did not restore keyboard focus"
  );
  const beforePendingCancel = transcripts.length;
  key("Enter");
  await pause();
  key("Escape");
  await pause();
  resolveUpload!({ text: "Do not send this cancelled memo." });
  await pause();
  assert(
    signal?.aborted && transcripts.length === beforePendingCancel,
    "Cancelling a pending send did not abort it"
  );
  assert(
    !editor.textContent?.includes("Do not send this cancelled memo."),
    "Cancelled send edited the draft"
  );
  reports.push("Escape after stopping cancels transcription and clears a queued send");

  let resolveHeldPermission: ((stream: MediaStream) => void) | undefined;
  media = () =>
    new Promise((resolve) => {
      resolveHeldPermission = resolve;
    });
  key("d", "keydown", shortcut);
  await pause(600);
  key("d", "keyup", shortcut);
  await pause();
  const beforeHeldPermission = stoppedTracks;
  resolveHeldPermission!({
    getTracks: () => [
      {
        stop() {
          stoppedTracks++;
        },
      },
    ],
  } as unknown as MediaStream);
  await pause();
  assert(
    stoppedTracks === beforeHeldPermission + 1 && !button("Stop recording"),
    "Releasing a held shortcut leaked a late microphone grant"
  );
  reports.push("releasing a held shortcut while permission is pending discards its late stream");

  let resolveMedia: ((stream: MediaStream) => void) | undefined;
  media = () =>
    new Promise((resolve) => {
      resolveMedia = resolve;
    });
  button("Record voice note")!.click();
  await pause();
  const beforeLate = stoppedTracks;
  render(true, "other-chat");
  await pause();
  resolveMedia!({
    getTracks: () => [
      {
        stop: () => {
          stoppedTracks++;
        },
      },
    ],
  } as unknown as MediaStream);
  await pause();
  assert(
    stoppedTracks === beforeLate + 1,
    "Late permission result leaked microphone after navigation"
  );
  reports.push("navigation releases a late microphone permission result");
  let savedInput: Record<string, unknown> | undefined;
  api.transcriptionSettings = async () => ({
    ...defaultTranscriptionSettings(),
    configured: false,
    hasApiKey: false,
  });
  api.updateTranscriptionSettings = async (input) => {
    savedInput = input as unknown as Record<string, unknown>;
    const { apiKey: _key, ...settings } = input;
    return { ...settings, configured: true, hasApiKey: true };
  };
  api.checkTranscription = async () => ({
    level: "pass",
    status: "ready",
    detail: "Provider connection verified",
  });
  root.render(<TranscriptionSettingsPanel />);
  await pause();
  const provider = document.querySelector<HTMLSelectElement>(
    '[aria-label="Transcription provider"]'
  )!;
  provider.value = "openai";
  provider.dispatchEvent(new Event("change", { bubbles: true }));
  await pause();
  const model = document.querySelector<HTMLInputElement>('[aria-label="Transcription model"]')!;
  assert(model.value === "whisper-1", "OpenAI model default missing");
  const apiKey = document.querySelector<HTMLInputElement>('[aria-label="Transcription API key"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    apiKey,
    "synthetic-api-key"
  );
  apiKey.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector<HTMLInputElement>('[aria-label="Enable voice notes"]')!.click();
  await pause();
  textButton("Save transcription")!.click();
  await pause();
  assert(
    savedInput?.apiKey === "synthetic-api-key" && savedInput?.enabled === true,
    "Settings did not save selected provider and credentials"
  );
  assert(apiKey.value === "", "Key remains in the password field after saving");
  textButton("Test connection")!.click();
  await pause();
  assert(
    document.body.textContent?.includes("Provider connection verified"),
    "Connection result missing"
  );
  reports.push("provider setup saves credentials, clears the key field, and tests connectivity");
  return { reports, uploads };
}
run()
  .then((result) => {
    (window as any).voiceResults = result;
  })
  .catch((error) => {
    (window as any).voiceResults = { error: error.message, stack: error.stack };
  });

// Isolated screenshot states: synthetic media only; no physical mic or real chat.
(window as any).voiceScreenshotStates = [
  "idle",
  "recording",
  "processing",
  "error",
  "disabled",
  "dark-recording",
  "narrow-recording",
];
(window as any).prepareVoiceScreenshot = async (state: string) => {
  button("Cancel voice note")?.click();
  document.documentElement.dataset.theme = state === "dark-recording" ? "dark" : "light";
  document.getElementById("root")!.style.height = "auto";
  document.getElementById("root")!.style.minHeight = "0";
  document.body.style.maxWidth = state === "narrow-recording" ? "380px" : "620px";
  media = async () =>
    ({
      getTracks: () => [Object.assign(new EventTarget(), { stop() {} })],
    }) as unknown as MediaStream;
  upload =
    state === "error"
      ? async () => {
          throw new Error("Transcription server unavailable. Try again.");
        }
      : () => new Promise(() => {});
  render(state !== "disabled", `screenshot-${state}`);
  await pause(100);
  if (state.includes("recording") || state === "processing" || state === "error") {
    button("Record voice note")!.click();
    await pause(1100);
    if (state === "processing" || state === "error") {
      button("Stop recording")!.click();
      await pause(350);
    }
  }
  const makeReference = (window as any).createGrokRecordingChip;
  document.getElementById("voice-reference")?.remove();
  if (state === "recording" && makeReference) {
    const host = document.createElement("div");
    host.id = "voice-reference";
    host.style.cssText = "margin:32px 16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif";
    document.body.append(host);
    const Reference = makeReference(React);
    createRoot(host).render(
      <>
        <p style={{ fontSize: 12, marginBottom: 12 }}>
          Grok Bot 0.47 recording chip, rendered from installed source
        </p>
        <Reference duration="0:01" onStop={() => {}} onCancel={() => {}} />
      </>
    );
    await pause(100);
    const actual = document.querySelector<HTMLElement>("[data-voice-recording-chip]")!;
    const reference = host.querySelector<HTMLElement>("button")!;
    const dimensions = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        width: box.width,
        height: box.height,
        gap: style.gap,
        padding: style.padding,
        background: style.backgroundColor,
        children: Array.from(node.children).map((child) => {
          const box = child.getBoundingClientRect();
          const style = getComputedStyle(child);
          return {
            width: box.width,
            height: box.height,
            color: style.color,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
          };
        }),
      };
    };
    (window as any).voiceVisualComparison = {
      actual: dimensions(actual),
      reference: dimensions(reference),
    };
    assert(
      Math.abs(actual.getBoundingClientRect().width - reference.getBoundingClientRect().width) <
        0.1,
      "Recording chip width differs from Grok reference"
    );
    assert(
      actual.getBoundingClientRect().height === reference.getBoundingClientRect().height,
      "Recording chip height differs from Grok reference"
    );
  }
};
(window as any).finishVoiceScreenshot = () => button("Cancel voice note")?.click();
