import {
  addSpeechErrorListener,
  addSpeechLevelListener,
  cancelVoiceRecording,
  startVoiceRecording,
  stopVoiceRecording,
  voiceRecordingAvailable,
  type SpeechState,
  type VoiceRecording,
} from "@openteam/mobile-native";
import { MAX_VOICE_NOTE_MS, MIN_VOICE_NOTE_MS } from "@openteam/contracts/transcription";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

export interface VoiceInputController {
  available: boolean;
  state: SpeechState;
  elapsedMs: number;
  levels: number[];
  error: string | null;
  canRetry: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  retry: () => void;
}

export const useVoiceInput = (
  onTranscript: (transcript: string) => void,
  configured = false,
  onTranscribe?: (uri: string, signal: AbortSignal) => Promise<{ text: string }>
): VoiceInputController => {
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const transcribe = useRef(onTranscribe);
  transcribe.current = onTranscribe;
  const [state, setState] = useState<SpeechState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState(() => Array.from({ length: 12 }, () => 0.08));
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const recording = useRef(false);
  const pending = useRef<VoiceRecording | null>(null);
  const abort = useRef<AbortController | null>(null);
  const stopRef = useRef<() => void>(() => undefined);
  const remove = (uri: string) => {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      /* Native start also removes abandoned temporary recordings. */
    }
  };
  const cleanup = () => {
    generation.current++;
    abort.current?.abort();
    cancelVoiceRecording();
    recording.current = false;
    busy.current = false;
    startedAt.current = 0;
    if (pending.current) remove(pending.current.uri);
    pending.current = null;
  };
  const cancel = () => {
    cleanup();
    setState("idle");
    setElapsedMs(0);
    setError(null);
  };
  useEffect(() => {
    const levelSubscription = addSpeechLevelListener(({ level }) => {
      setLevels((current) => [...current.slice(1), Math.max(0.08, Math.min(1, level))]);
    });
    const errorSubscription = addSpeechErrorListener((event) => {
      cleanup();
      setError(event.message);
      setState("error");
    });
    const appState = AppState.addEventListener("change", (next) => {
      if (next !== "active" && recording.current) cancel();
    });
    return () => {
      levelSubscription?.remove();
      errorSubscription?.remove();
      appState.remove();
      cleanup();
    };
  }, []);
  useEffect(() => {
    if (!configured) cancel();
  }, [configured]);
  useEffect(() => {
    if (state !== "recording") return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAt.current;
      setElapsedMs(Math.min(elapsed, MAX_VOICE_NOTE_MS));
      if (elapsed >= MAX_VOICE_NOTE_MS) stopRef.current();
    }, 200);
    return () => clearInterval(interval);
  }, [state]);

  const available = configured && voiceRecordingAvailable && Boolean(onTranscribe);
  const processRecording = async (file: VoiceRecording, session: number) => {
    if (session !== generation.current) {
      remove(file.uri);
      return;
    }
    pending.current = file;
    setState("processing");
    setError(null);
    busy.current = true;
    const controller = new AbortController();
    abort.current = controller;
    try {
      if (!transcribe.current) throw new Error("Set up transcription in Server settings.");
      const result = await transcribe.current(file.uri, controller.signal);
      if (session !== generation.current) return;
      remove(file.uri);
      pending.current = null;
      busy.current = false;
      setState("idle");
      callback.current(result.text);
    } catch (cause) {
      if (session !== generation.current) return;
      busy.current = false;
      setState("error");
      setError(cause instanceof Error ? cause.message : "Transcription failed. Try again.");
    }
  };
  const start = async () => {
    if (!available || busy.current || recording.current) return;
    cleanup();
    const session = generation.current;
    busy.current = true;
    setState("requesting");
    setError(null);
    setElapsedMs(0);
    setLevels(Array.from({ length: 12 }, () => 0.08));
    try {
      await startVoiceRecording();
      if (session !== generation.current) return;
      startedAt.current = Date.now();
      recording.current = true;
      busy.current = false;
      setState("recording");
    } catch (cause) {
      if (session !== generation.current) return;
      busy.current = false;
      setState("error");
      setError(cause instanceof Error ? cause.message : "Could not start the microphone.");
    }
  };
  const stop = async () => {
    if (!recording.current || busy.current) return;
    recording.current = false;
    busy.current = true;
    setState("processing");
    const session = generation.current;
    try {
      const file = await stopVoiceRecording();
      if (session !== generation.current) {
        remove(file.uri);
        return;
      }
      if (file.durationMs < MIN_VOICE_NOTE_MS) {
        remove(file.uri);
        throw new Error("Voice note was too short. Try speaking for longer.");
      }
      await processRecording(file, session);
    } catch (cause) {
      if (session !== generation.current) return;
      busy.current = false;
      setState("error");
      setError(cause instanceof Error ? cause.message : "Could not finish recording.");
    }
  };
  stopRef.current = () => void stop();
  return {
    available,
    state,
    elapsedMs,
    levels,
    error,
    canRetry: state === "error" && Boolean(pending.current),
    start: () => void start(),
    stop: () => void stop(),
    cancel,
    retry: () => {
      if (pending.current && !busy.current)
        void processRecording(pending.current, generation.current);
    },
  };
};
