import { useEffect, useRef, useState } from "react";
import {
  MICROPHONE_DISCONNECTED,
  MICROPHONE_FALLBACK,
  microphoneErrorMessage,
  openMicrophone,
} from "../lib/microphone";

export function useMicrophoneTest(deviceId: string) {
  const [state, setState] = useState<"idle" | "requesting" | "testing">("idle");
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const dispose = useRef<(() => void) | null>(null);
  const cleanup = () => {
    generation.current++;
    dispose.current?.();
    dispose.current = null;
  };
  const stop = (detail = "Microphone test stopped.") => {
    cleanup();
    setState("idle");
    setLevel(0);
    setMessage(detail);
  };
  useEffect(() => {
    stop("");
    const onHidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      cleanup();
    };
  }, [deviceId]);
  const start = async () => {
    if (dispose.current) return;
    cleanup();
    const session = generation.current;
    const abort = new AbortController();
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnected = () => stop(MICROPHONE_DISCONNECTED);
    dispose.current = () => {
      abort.abort();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      source?.disconnect();
      stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", disconnected);
        track.stop();
      });
      void context?.close().catch(() => undefined);
    };
    setState("requesting");
    setMessage("");
    try {
      const opened = await openMicrophone({ deviceId, signal: abort.signal });
      // The helper also releases streams that arrive after cancellation.
      stream = opened.stream;
      if (session !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.getTracks().forEach((track) => track.addEventListener("ended", disconnected));
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser); // No speaker output, file, or network request.
      await context.resume();
      if (session !== generation.current) return;
      setState("testing");
      setMessage(opened.usedFallback ? MICROPHONE_FALLBACK : "Speak to check the input level.");
      const samples = new Float32Array(analyser.fftSize);
      let lastSample = 0;
      const sample = (now: number) => {
        if (session !== generation.current) return;
        if (now - lastSample >= 100) {
          lastSample = now;
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(
            samples.reduce((sum, value) => sum + value * value, 0) / samples.length
          );
          setLevel(Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 0.00001)) + 60) / 60)));
        }
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      timer = setTimeout(() => stop("Microphone test finished."), 30_000);
    } catch (error) {
      if (session !== generation.current) return;
      stop(microphoneErrorMessage(error));
    }
  };
  return { state, level, message, start: () => void start(), stop: () => stop() };
}
