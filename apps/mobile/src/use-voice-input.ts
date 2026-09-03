import {
  addSpeechErrorListener,
  addSpeechLevelListener,
  addSpeechResultListener,
  addSpeechStateListener,
  cancelSpeech,
  openTeamNativeAvailable,
  type SpeechState,
  startSpeech,
  stopSpeech,
} from "@openteam/mobile-native";
import { useEffect, useRef, useState } from "react";

const MAX_RECORDING_MS = 300_000;
const MIN_RECORDING_MS = 500;
const LEVEL_COUNT = 12;

export interface VoiceInputController {
  available: boolean;
  state: SpeechState;
  elapsedMs: number;
  levels: number[];
  error: string | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
}

export const useVoiceInput = (onTranscript: (transcript: string) => void): VoiceInputController => {
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const [state, setState] = useState<SpeechState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState(() => Array.from({ length: LEVEL_COUNT }, () => 0.08));
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const transcript = useRef("");
  const delivered = useRef(false);

  useEffect(() => {
    const stateSubscription = addSpeechStateListener(({ state: nextState }) => {
      setState(nextState);
      if (nextState === "recording") {
        startedAt.current = Date.now();
        setElapsedMs(0);
      }
    });
    const resultSubscription = addSpeechResultListener((result) => {
      transcript.current = result.transcript;
      if (!result.final || delivered.current || !result.transcript.trim()) return;
      delivered.current = true;
      callback.current(result.transcript.trim());
    });
    const levelSubscription = addSpeechLevelListener(({ level }) => {
      setLevels((current) => [...current.slice(1), Math.max(0.08, Math.min(1, level))]);
    });
    const errorSubscription = addSpeechErrorListener((event) => {
      setError(event.message);
    });
    return () => {
      stateSubscription?.remove();
      resultSubscription?.remove();
      levelSubscription?.remove();
      errorSubscription?.remove();
      cancelSpeech();
    };
  }, []);

  useEffect(() => {
    if (state !== "requesting" && state !== "recording") return;
    const update = () => {
      if (startedAt.current === 0) return;
      const elapsed = Date.now() - startedAt.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) stopSpeech();
    };
    update();
    const interval = setInterval(update, 200);
    return () => clearInterval(interval);
  }, [state]);

  const start = () => {
    if (!openTeamNativeAvailable) return;
    setError(null);
    setElapsedMs(0);
    setLevels(Array.from({ length: LEVEL_COUNT }, () => 0.08));
    startedAt.current = 0;
    transcript.current = "";
    delivered.current = false;
    setState("requesting");
    startSpeech();
  };

  const cancel = () => {
    cancelSpeech();
    startedAt.current = 0;
    transcript.current = "";
    setElapsedMs(0);
    setState("idle");
  };

  const stop = () => {
    const elapsed = startedAt.current === 0 ? 0 : Date.now() - startedAt.current;
    if (elapsed < MIN_RECORDING_MS) {
      cancel();
      setError("Voice input was too short. Try speaking for a little longer.");
      return;
    }
    setState("processing");
    stopSpeech();
  };

  return {
    available: openTeamNativeAvailable,
    state,
    elapsedMs,
    levels,
    error,
    start,
    stop,
    cancel,
  };
};
