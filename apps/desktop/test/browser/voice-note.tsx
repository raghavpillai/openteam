import React from "react";
import { createRoot } from "react-dom/client";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { api } from "../../src/renderer/client/openteam-api";
import ServerSettings from "../../src/renderer/components/openteam/settings/server";
import { ThreadTray } from "../../src/renderer/components/openteam/thread-tray";

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
    `${message}: ${document.body.textContent?.slice(0, 600)} ${renderErrors.join("\n")} ${JSON.stringify({ uploads, transcripts, trace: trace.slice(-30), editor: document.querySelector("[contenteditable]")?.textContent })}`
  );
};
const trace: string[] = [];
const traceStart = performance.now();
new MutationObserver(() => {
  const mode = document.querySelector("[data-voice-memo]")?.getAttribute("data-voice-memo") ?? "-";
  if (trace.at(-1)?.endsWith(` ${mode}`)) return;
  trace.push(`${Math.round(performance.now() - traceStart)} ${mode}`);
}).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["data-voice-memo"],
});
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
const editorElement = () => document.querySelector<HTMLElement>("[contenteditable]")!;
// The layer keeps its last mode while it animates away; that isn't the mode.
const voiceLayer = (mode: string) =>
  document.querySelector(`[data-voice-memo="${mode}"]:not([data-exiting])`);
const shortcut = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
const key = (key: string, type = "keydown", modifiers = {}) =>
  editorElement().dispatchEvent(
    new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...modifiers })
  );
// Keyboard dictation: the shortcut starts hands-free and stops into the draft.
const dictate = async () => {
  const editor = editorElement();
  if (document.activeElement !== editor) {
    // Like clicking at the end of the draft before pressing the shortcut.
    editor.focus();
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(end);
  }
  // A tap: key-up follows at once, so slow test timers can't turn it into a hold.
  key("d", "keydown", shortcut);
  key("d", "keyup", shortcut);
  await pause(600);
  key("d", "keydown", shortcut);
  key("d", "keyup", shortcut);
  await pause(80);
};
// Type a draft: the caret ends up after it, as it does for a person typing.
const setDraft = async (text: string) => {
  const editor = editorElement();
  editor.textContent = text;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  editor.focus();
  const end = document.createRange();
  end.selectNodeContents(editor);
  end.collapse(false);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(end);
  await pause();
};
// The mic turns the composer into the recording bar; Send transcribes and sends.
const recordAndSend = async (ms = 800) => {
  button("Record voice note")!.click();
  await pause(ms);
  button("Send voice note")!.click();
  await pause(120);
};

async function run() {
  const reports: string[] = [];
  render(false);
  await pause(80);
  const disabled = button("Set up transcription in Voice notes settings to use voice notes")!;
  assert(disabled?.disabled, "Microphone must be disabled before setup");
  disabled.click();
  await pause();
  assert(requested === 0, "Disabled microphone requested access");
  reports.push("microphone disabled without transcription");
  render(true);
  await pause();
  const editor = editorElement();
  editor.innerHTML =
    '<span data-mention-id="bot-1" data-mention-label="Helper" data-mention-handle="helper" contenteditable="false">@Helper</span> existing draft';
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  const mention = editor.querySelector("span");
  await dictate();
  await waitFor(
    () => Boolean(editor.textContent?.endsWith("existing draft Ship it tomorrow.")),
    "Transcript did not append to draft"
  );
  assert(editor.querySelector("span") === mention, "Transcription replaced mention token");
  assert(stoppedTracks === 1, "Microphone track not released after stop");
  button("Send message")!.click();
  button("Send message")?.click();
  await pause();
  assert(
    transcripts.length === 1 && transcripts[0]!.includes("Ship it tomorrow."),
    "Submitted content missed transcript"
  );
  reports.push("dictate, append with mentions, stop microphone, and submit");

  editor.textContent = "Send OLD tomorrow.";
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  editor.focus();
  const selected = document.createRange();
  selected.setStart(editor.firstChild!, 5);
  selected.setEnd(editor.firstChild!, 8);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(selected);
  upload = async () => ({ text: "Raghav $1,203.05" });
  await dictate();
  assert(
    editor.textContent === "Send Raghav $1,203.05 tomorrow.",
    "Voice did not replace the saved selection exactly"
  );
  assert(window.getSelection()?.isCollapsed, "Caret was not restored after insertion");
  button("Send message")!.click();
  await pause();
  reports.push(
    "dictation replaces the bookmarked selection and preserves names, numbers, and suffix"
  );

  editor.innerHTML =
    '<span data-mention-id="bot-1" data-mention-label="Helper" data-mention-handle="helper" contenteditable="false">@Helper</span> tail';
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  editor.focus();
  const middle = document.createRange();
  middle.setStart(editor.lastChild!, 0);
  middle.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(middle);
  const keptMention = editor.firstChild;
  upload = async () => ({ text: "review" });
  await dictate();
  assert(
    editor.textContent === "@Helper review tail",
    "Insertion next to mention moved to the end"
  );
  assert(editor.firstChild === keptMention, "Cursor insertion replaced a mention token");
  button("Send message")!.click();
  await pause();
  reports.push("dictation at the cursor preserves adjacent mention identity");

  upload = async () => {
    throw new Error("Provider offline");
  };
  await dictate();
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
  button("Send message")!.click();
  await pause();
  reports.push("provider failure keeps audio for retry");

  let resolveUpload: ((value: { text: string }) => void) | undefined;
  let signal: AbortSignal | undefined;
  upload = async (_audio, nextSignal) => {
    signal = nextSignal;
    return new Promise((resolve) => {
      resolveUpload = resolve;
    });
  };
  await dictate();
  await waitFor(() => Boolean(button("Cancel voice note")), "transcribing bar cancel");
  assert(Boolean(voiceLayer("processing")), "Transcription did not show the transcribing bar");
  button("Cancel voice note")!.click();
  await pause();
  assert(signal?.aborted, "Cancel did not abort upload");
  resolveUpload!({ text: "Cancelled text" });
  await pause();
  assert(!editor.textContent?.includes("Cancelled text"), "Cancelled result edited draft");
  reports.push("cancellation aborts upload and discards late result");

  // The recording bar: Send transcribes and sends the draft with the memo, once.
  await setDraft("Before the memo:");
  upload = async () => ({ text: "Send this voice memo." });
  const beforeBarSend = transcripts.length;
  const tracksBeforeBar = stoppedTracks;
  button("Record voice note")!.click();
  await pause(800);
  assert(Boolean(voiceLayer("recording")), "Recording did not show the recording bar");
  assert(
    Boolean(document.querySelector("[data-prompt-surface][data-voice-mode] [data-prompt-content]")),
    "The composer's own controls stayed active under the recording bar"
  );
  button("Send voice note")!.click();
  await waitFor(() => transcripts.length === beforeBarSend + 1, "Send did not send");
  await pause(80);
  assert(transcripts.length === beforeBarSend + 1, "Send sent more than once");
  assert(
    transcripts.at(-1) === "Before the memo: Send this voice memo.",
    `Send sent the wrong text: ${transcripts.at(-1)}`
  );
  assert(stoppedTracks === tracksBeforeBar + 1, "Send kept the microphone open");
  assert(!editor.textContent?.trim(), "Sent memo left text in the draft");
  reports.push("the recording bar's Send transcribes and sends the draft with the memo, once");

  await setDraft("Keep this draft");
  const trashUploads = uploads;
  const trashTracks = stoppedTracks;
  button("Record voice note")!.click();
  await pause(400);
  button("Discard voice note")!.click();
  await pause(80);
  assert(
    uploads === trashUploads && stoppedTracks === trashTracks + 1 && !voiceLayer("recording"),
    "The trash button uploaded or kept the microphone"
  );
  await pause(300);
  assert(editor.textContent === "Keep this draft", "Discarding changed the draft");
  await setDraft("");
  reports.push("the trash button discards, releases the microphone, and keeps the draft");

  const escapeUploads = uploads;
  button("Record voice note")!.click();
  await pause(300);
  key("Escape");
  await pause(80);
  assert(
    uploads === escapeUploads && !voiceLayer("recording"),
    "Escape did not discard the recording"
  );
  await pause(300);
  reports.push("Escape discards a recording");

  editor.focus();
  key("d", "keydown", shortcut);
  key("d", "keyup", shortcut);
  await pause(550);
  assert(Boolean(voiceLayer("recording")), "Tap shortcut did not keep recording");
  const beforeStop = transcripts.length;
  upload = async () => ({ text: "Send this voice memo." });
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
  assert(!voiceLayer("recording"), "Held shortcut did not stop on release");
  await waitFor(() => !voiceLayer("processing"), "held shortcut transcription");
  const beforeCancel = uploads;
  key("d", "keydown", shortcut);
  await pause(600);
  key("Escape");
  key("d", "keyup", shortcut);
  await pause(80);
  assert(uploads === beforeCancel && !voiceLayer("recording"), "Escape uploaded cancelled audio");
  await pause(700);
  button("Send message")!.click();
  await pause();
  reports.push("shortcut tap/hold, Enter to review, and Escape cancellation");

  upload = async () => {
    throw new Error("Voice send failed");
  };
  const failedSendCount = transcripts.length;
  await recordAndSend();
  await waitFor(() => Boolean(textButton("Retry transcription")), "failed send retry");
  upload = async () => ({ text: "Review the retry first." });
  textButton("Retry transcription")!.click();
  await pause(100);
  assert(
    transcripts.length === failedSendCount,
    "Retry unexpectedly sent a previously failed memo"
  );
  assert(editor.textContent?.includes("Review the retry first."), "Retry lost the draft");
  button("Send message")!.click();
  await pause();
  reports.push("failed voice send retries into the draft without an unexpected send");

  upload = async (_audio, nextSignal) => {
    signal = nextSignal;
    return new Promise((resolve) => {
      resolveUpload = resolve;
    });
  };
  await dictate();
  assert(document.activeElement === editor, "Stopping dictation did not restore keyboard focus");
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
    stoppedTracks === beforeHeldPermission + 1 && !voiceLayer("recording"),
    "Releasing a held shortcut leaked a late microphone grant"
  );
  reports.push("releasing a held shortcut while permission is pending discards its late stream");

  let resolveBarPermission: ((stream: MediaStream) => void) | undefined;
  media = () =>
    new Promise((resolve) => {
      resolveBarPermission = resolve;
    });
  button("Record voice note")!.click();
  await pause();
  assert(Boolean(voiceLayer("recording")), "The bar did not show while the microphone opened");
  button("Discard voice note")!.click();
  await pause();
  const beforeBarPermission = stoppedTracks;
  resolveBarPermission!({
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
    stoppedTracks === beforeBarPermission + 1,
    "Discarding while the microphone opened leaked its late stream"
  );
  await pause(300);
  reports.push("discarding while permission is pending releases the late stream");

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
  const threadProps = {
    botById: new Map(),
    mentionOptions: [],
    open: true,
    replies: [],
    deliveries: [],
    recoveries: [],
    root: {
      id: "voice-thread",
      channelId: "voice-channel",
      clientId: "voice-root",
      sender: "user",
      senderBotId: null,
      content: "Thread root",
      metadata: {},
      sequence: "1",
      createdAt: new Date().toISOString(),
    } as any,
    onClose: () => undefined,
    onCancelSend: async () => null,
    onDeleteSend: async () => undefined,
    onResendSend: async () => undefined,
    onAcknowledgeRecovery: async () => undefined,
    onStage: async () => {
      throw new Error("Voice cannot attach files");
    },
    onSubmit: async (text: string) => {
      transcripts.push(text);
    },
  };
  root.render(<ThreadTray {...threadProps} transcriptionConfigured={false} />);
  await pause(100);
  assert(
    button("Set up transcription in Voice notes settings to use voice notes")?.disabled,
    "Unconfigured thread mic was enabled"
  );
  root.render(<ThreadTray {...threadProps} transcriptionConfigured />);
  await pause(100);
  media = async () =>
    ({
      getTracks: () => [
        Object.assign(new EventTarget(), {
          stop() {
            stoppedTracks++;
          },
        }),
      ],
    }) as unknown as MediaStream;
  upload = async () => ({ text: "Voice reply in this thread." });
  const threadSendCount = transcripts.length;
  await recordAndSend();
  await waitFor(() => transcripts.length === threadSendCount + 1, "thread voice reply");
  assert(
    transcripts.at(-1) === "Voice reply in this thread.",
    "Thread voice memo was disabled or lost its content"
  );
  reports.push("actual thread composer respects setup and sends its voice reply exactly once");
  upload = async (_audio, nextSignal) => {
    signal = nextSignal;
    return new Promise((resolve) => {
      resolveUpload = resolve;
    });
  };
  await recordAndSend();
  root.render(<ThreadTray {...threadProps} open={false} transcriptionConfigured />);
  await pause();
  resolveUpload!({ text: "Closed thread must not send." });
  await pause();
  assert(
    signal?.aborted && transcripts.length === threadSendCount + 1,
    "Closing an animating thread allowed a late voice send"
  );
  reports.push("closing a thread aborts transcription before its exit animation finishes");
  const configurationCalls: string[] = [];
  for (const method of [
    "serverSettings",
    "startInferenceProviderAuth",
    "updateInferenceSettings",
    "disconnectInferenceProvider",
    "transcriptionSettings",
    "updateTranscriptionSettings",
    "checkTranscription",
  ] as const) {
    api[method] = async () => {
      configurationCalls.push(method);
      throw new Error("Configuration is managed on the server");
    };
  }
  root.render(<ServerSettings />);
  await pause();
  assert(
    !document.querySelector('input, [role="combobox"]') &&
      !textButton("Save transcription") &&
      !textButton("Test connection") &&
      !textButton("Apply"),
    "Server settings still exposes transcription controls"
  );
  assert(configurationCalls.length === 0, "Server settings accessed configuration APIs");
  reports.push("Server settings leaves transcription in its dedicated Voice notes section");
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
  document.documentElement.dataset.theme = state.startsWith("dark") ? "dark" : "light";
  document.getElementById("root")!.style.height = "auto";
  document.getElementById("root")!.style.minHeight = "0";
  document.body.style.maxWidth = state.startsWith("narrow") ? "380px" : "620px";
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
  if (state === "idle" || state === "disabled") return;
  button("Record voice note")!.click();
  await pause(1100);
  if (state === "processing" || state === "error") {
    button("Send voice note")!.click();
    await pause(450);
  }
};
(window as any).finishVoiceScreenshot = () => {
  button("Discard voice note")?.click();
  button("Cancel voice note")?.click();
};
