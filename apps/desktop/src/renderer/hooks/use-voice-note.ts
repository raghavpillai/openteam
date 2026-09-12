import {
  MAX_VOICE_NOTE_BYTES,
  MAX_VOICE_NOTE_MS,
  MIN_VOICE_NOTE_MS,
} from "@openteam/contracts/transcription";
import { useEffect, useRef, useState } from "react";
import { api } from "../client/openteam-api";
import {
  MICROPHONE_DISCONNECTED,
  MICROPHONE_FALLBACK,
  microphoneErrorMessage,
  openMicrophone,
} from "../lib/microphone";

export function useVoiceNote(configured: boolean, onTranscript: (text: string) => void) {
  const [state, setState] = useState<"idle" | "requesting" | "recording" | "processing" | "error">(
    "idle"
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const callback = useRef(onTranscript);
  const pendingAudio = useRef<Blob | null>(null);
  const starting = useRef(false);
  const detachTracks = useRef<(() => void) | null>(null);
  callback.current = onTranscript;
  const cleanup = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    detachTracks.current?.();
    detachTracks.current = null;
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };
  const cancel = () => {
    generation.current++;
    starting.current = false;
    controller.current?.abort();
    cleanup();
    pendingAudio.current = null;
    setState("idle");
    setError(null);
    setNotice(null);
    setElapsedMs(0);
  };
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
      cleanup();
      pendingAudio.current = null;
    },
    []
  );
  useEffect(() => {
    if (!configured) cancel();
  }, [configured]);
  const processAudio = async (audio: Blob, session: number) => {
    pendingAudio.current = audio;
    setState("processing");
    setError(null);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await api.transcribeAudio(audio, abort.signal);
      if (session !== generation.current) return;
      pendingAudio.current = null;
      setState("idle");
      callback.current(result.text);
    } catch (cause) {
      if (session !== generation.current) return;
      setState("error");
      setError(cause instanceof Error ? cause.message : "Transcription failed. Try again.");
    }
  };
  const available =
    configured &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const start = async () => {
    if (!available || starting.current || ["requesting", "recording", "processing"].includes(state))
      return;
    starting.current = true;
    const session = ++generation.current;
    pendingAudio.current = null;
    setError(null);
    setElapsedMs(0);
    setNotice(null);
    setState("requesting");
    const permissionRequest = new AbortController();
    controller.current = permissionRequest;
    try {
      const { stream: media, usedFallback } = await openMicrophone({
        signal: permissionRequest.signal,
      });
      if (session !== generation.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      setNotice(usedFallback ? MICROPHONE_FALLBACK : null);
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );
      const recording = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      recorder.current = recording;
      const chunks: Blob[] = [];
      let size = 0;
      let failure: string | null = null;
      const disconnected = () => {
        if (session !== generation.current) return;
        failure = MICROPHONE_DISCONNECTED;
        if (recording.state === "recording") recording.stop();
      };
      const tracks = media.getTracks();
      tracks.forEach((track) => track.addEventListener("ended", disconnected));
      detachTracks.current = () =>
        tracks.forEach((track) => track.removeEventListener("ended", disconnected));
      let stoppedAt = 0;
      const startedAt = Date.now();
      recording.ondataavailable = (event) => {
        size += event.data.size;
        if (size <= MAX_VOICE_NOTE_BYTES) chunks.push(event.data);
        else {
          failure = "The recording is too large. Try a shorter voice note.";
          if (recording.state === "recording") recording.stop();
        }
      };
      recording.onerror = () => {
        if (session !== generation.current) return;
        failure = "Microphone recording failed. Try again.";
        cleanup();
        starting.current = false;
        setState("error");
        setError(failure);
      };
      recording.onstop = () => {
        if (session !== generation.current) return;
        cleanup();
        starting.current = false;
        const duration = (stoppedAt || Date.now()) - startedAt;
        if (failure || duration < MIN_VOICE_NOTE_MS) {
          setState("error");
          setError(failure ?? "Voice note was too short. Try speaking for longer.");
          return;
        }
        void processAudio(
          new Blob(chunks, { type: recording.mimeType || mimeType || "audio/webm" }),
          session
        );
      };
      recording.start(1000);
      starting.current = false;
      setState("recording");
      timer.current = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        setElapsedMs(Math.min(elapsed, MAX_VOICE_NOTE_MS));
        if (elapsed >= MAX_VOICE_NOTE_MS && recording.state === "recording") {
          stoppedAt = Date.now();
          recording.stop();
        }
      }, 200);
    } catch (cause) {
      if (session !== generation.current) return;
      starting.current = false;
      cleanup();
      setState("error");
      setError(microphoneErrorMessage(cause));
    }
  };
  return {
    state,
    stream: state === "recording" ? stream.current : null,
    elapsedMs,
    error,
    notice,
    available,
    active: state === "requesting" || state === "recording" || state === "processing",
    canRetry: state === "error" && Boolean(pendingAudio.current),
    start: () => void start(),
    stop: () => {
      if (state === "requesting") {
        cancel();
        return;
      }
      if (recorder.current?.state === "recording") {
        setState("processing");
        recorder.current.stop();
      }
    },
    cancel,
    retry: () => {
      if (pendingAudio.current && state === "error")
        void processAudio(pendingAudio.current, generation.current);
    },
  };
}
