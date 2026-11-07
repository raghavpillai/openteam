import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../client/openteam-api";
import { LiveVoiceAudio } from "../lib/live-voice-audio";
import { LiveVoiceTransport } from "../lib/live-voice-transport";

export type LiveVoiceUiState = "idle" | "connecting" | "listening" | "processing" | "speaking" | "interrupted" | "error";

export interface LiveVoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function useLiveVoice(botId: string, channelId: string) {
  const [state, setState] = useState<LiveVoiceUiState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<LiveVoiceTranscriptEntry[]>([]);
  const [partialText, setPartialText] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [available, setAvailable] = useState(false);
  const transport = useRef<LiveVoiceTransport | null>(null);
  const audio = useRef<LiveVoiceAudio | null>(null);
  const sessionId = useRef<string | null>(null);
  const stateRef = useRef<LiveVoiceUiState>("idle");

  const refreshAvailability = useCallback(async () => {
    try {
      const settings = await api.voice.settings();
      setAvailable(settings.enabled);
      return settings.enabled;
    } catch {
      setAvailable(false);
      return false;
    }
  }, []);

  useEffect(() => {
    void refreshAvailability();
  }, [refreshAvailability]);

  const updateState = useCallback((next: LiveVoiceUiState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stop = useCallback(async () => {
    transport.current?.stop(); transport.current = null;
    await audio.current?.close().catch(() => undefined);
    audio.current = null;
    if (sessionId.current) await api.voice.endSession(sessionId.current).catch(() => undefined);
    sessionId.current = null;
    stateRef.current = "idle";
    setState("idle");
    setPartialText("");
    setStartedAt(null);
    setMicrophoneMuted(false);
    setSpeakerMuted(false);
  }, []);

  const start = useCallback(async () => {
    if (stateRef.current !== "idle") return;
    updateState("connecting");
    setError(null);
    setTranscript([]);
    setPartialText("");
    setStartedAt(Date.now());
    try {
      if (!(await refreshAvailability())) {
        throw new Error("Realtime voice is disabled or not configured on the server.");
      }
      const nextAudio = new LiveVoiceAudio({
        onFrame: frame => transport.current?.sendFrame(frame),
        onPlaybackAck: (generation, sequence) => transport.current?.acknowledge(generation, sequence),
      });
      audio.current = nextAudio;
      const ticket = await api.voice.createSession({ botId, channelId, clientPlatform: "macos", clientInstanceId: `desktop:${crypto.randomUUID()}` });
      sessionId.current = ticket.id;
      const next = new LiveVoiceTransport(ticket, {
        onControl: message => {
          if (message.type === "ready") { updateState("listening"); next.ready(); }
          else if (message.type === "turn.started") { setPartialText(""); updateState("listening"); }
          else if (message.type === "transcript.partial") { setPartialText(message.text); updateState("listening"); }
          else if (message.type === "transcript.final") {
            if (message.text.trim()) {
              setTranscript(current => [...current, { id: `${message.turnId}:user`, role: "user", text: message.text }]);
            }
            setPartialText("");
            updateState("processing");
          }
          else if (message.type === "reply.message") {
            setTranscript(current => [...current, { id: message.messageId, role: "assistant", text: message.text }]);
            updateState("speaking");
          }
          else if (message.type === "audio.started") updateState("speaking");
          else if (message.type === "barge_in" || message.type === "audio.stopped") { nextAudio.stopPlayback(); updateState("interrupted"); }
          else if (message.type === "ended") void stop();
          else if (message.type === "error") { updateState("error"); setError(message.message); }
        },
        onError: cause => { updateState("error"); setError(cause instanceof Error ? cause.message : "Voice connection failed"); },
        onAudio: frame => nextAudio.handleOutputFrame(frame),
        onClose: event => {
          void nextAudio.close();
          if (event.code !== 1000 && stateRef.current !== "idle") {
            updateState("error");
            setError(current => current ?? `Voice connection closed (${event.code})`);
          }
        },
      });
      transport.current = next;
      await next.connect();
      const capabilities = await nextAudio.start();
      next.hello(capabilities.echoCancellation);
    } catch (cause) {
      await stop();
      updateState("error");
      setError(cause instanceof Error ? cause.message : "Realtime voice is unavailable");
    }
  }, [botId, channelId, refreshAvailability, stop, updateState]);

  const restart = useCallback(async () => {
    await stop();
    await start();
  }, [start, stop]);

  const setMicrophoneMutedState = useCallback((muted: boolean) => {
    audio.current?.setMicrophoneMuted(muted);
    setMicrophoneMuted(muted);
  }, []);

  const setSpeakerMutedState = useCallback((muted: boolean) => {
    audio.current?.setSpeakerMuted(muted);
    setSpeakerMuted(muted);
  }, []);

  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => () => { void stop(); }, [stop]);

  return {
    state,
    available,
    error,
    transcript,
    partialText,
    startedAt,
    elapsedMs: startedAt === null ? 0 : Math.max(0, now - startedAt),
    microphoneMuted,
    speakerMuted,
    setMicrophoneMuted: setMicrophoneMutedState,
    setSpeakerMuted: setSpeakerMutedState,
    start,
    restart,
    stop,
  };
}
