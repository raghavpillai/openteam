import { createRoot } from "react-dom/client";
import { useVoiceNote } from "../../src/renderer/hooks/use-voice-note";
import { BotAvatarGlyph } from "../../src/renderer/components/openteam/avatar-picker-icons";
import VoiceMemoLayer from "../../src/renderer/components/openteam/voice-memo/voice-memo-layer";
import { LoadingOrb, preloadLoadingOrb } from "../../src/renderer/components/ui/loading-orb";
import { usePluginMentions } from "../../src/renderer/hooks/use-plugin-mentions";
import { useServerUpdateStatus } from "../../src/renderer/hooks/use-server-update-status";
import { api } from "../../src/renderer/client/openteam-api";
import { installWindowVisibility, isWindowActive, isWindowVisible, WINDOW_ACTIVITY_EVENT } from "../../src/renderer/lib/window-visibility";
import "../../src/renderer/styles.css";

const listeners = new Map<string, Set<unknown>>();
for (const method of ["addEventListener", "removeEventListener"] as const) {
  const original = EventTarget.prototype[method];
  EventTarget.prototype[method] = function (type, listener, options) {
    if (this === window || this === document) {
      const key = `${this === window ? "window" : "document"}:${type}:${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
      const set = listeners.get(key) ?? new Set();
      if (method === "addEventListener") set.add(listener); else set.delete(listener);
      listeners.set(key, set);
    }
    return original.call(this, type, listener, options);
  };
}
const observers = { mutation: new Set<unknown>(), resize: new Set<unknown>(), intersection: new Set<unknown>() };
for (const [Constructor, instances] of [[MutationObserver, observers.mutation], [ResizeObserver, observers.resize], [IntersectionObserver, observers.intersection]] as const) {
  const observe = Constructor.prototype.observe;
  const disconnect = Constructor.prototype.disconnect;
  Constructor.prototype.observe = function (...args: unknown[]) { instances.add(this); return observe.apply(this, args); };
  Constructor.prototype.disconnect = function () { instances.delete(this); return disconnect.call(this); };
}
const frames = new Set<number>();
const originalFrame = requestAnimationFrame.bind(window);
const originalCancelFrame = cancelAnimationFrame.bind(window);
window.requestAnimationFrame = callback => {
  const id = originalFrame(at => { frames.delete(id); callback(at); });
  frames.add(id);
  return id;
};
window.cancelAnimationFrame = id => { frames.delete(id); originalCancelFrame(id); };
const visualizerTracks = new Set<MediaStreamTrack>();
const originalClone = MediaStreamTrack.prototype.clone;
MediaStreamTrack.prototype.clone = function () {
  const track = originalClone.call(this);
  visualizerTracks.add(track);
  const stop = track.stop.bind(track);
  track.stop = () => { visualizerTracks.delete(track); stop(); };
  return track;
};
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

// Count actual canvas paints, including library RAF loops, without changing them.
const paints = new Map<HTMLCanvasElement, number>();
const originalClear = CanvasRenderingContext2D.prototype.clearRect;
CanvasRenderingContext2D.prototype.clearRect = function (...args) {
  paints.set(this.canvas, (paints.get(this.canvas) ?? 0) + 1);
  return originalClear.apply(this, args);
};
const intervals = new Map<number, { callback: () => void; delay: number }>();
const originalInterval = window.setInterval.bind(window);
const originalClearInterval = window.clearInterval.bind(window);
window.setInterval = ((callback: () => void, delay: number) => {
  const id = originalInterval(callback, delay);
  intervals.set(id, { callback, delay });
  return id;
}) as typeof window.setInterval;
window.clearInterval = (id) => {
  intervals.delete(id!);
  originalClearInterval(id);
};
let pluginReads = 0;
let updateReads = 0;
let updateState = "idle";
let updateUnavailable = false;
api.pluginComposer = async () => { pluginReads++; return { items: [] } as never; };
api.systemVersion = async () => { if (updateUnavailable) throw Error("offline"); return { releaseVersion: "0.0.13" } as never; };
api.serverUpdateStatus = async () => { updateReads++; if (updateUnavailable) throw Error("offline"); return { status: updateState } as never; };
api.updateServer = async () => { updateState = "updating"; return { status: "updating" } as never; };
let beginUpdate = () => {};
let refreshUpdate = () => {};
function Pollers() {
  usePluginMentions("test-bot");
  const { updateServer, refresh } = useServerUpdateStatus("0.0.13");
  beginUpdate = () => { void updateServer("0.0.14"); };
  refreshUpdate = () => { void refresh(); };
  return null;
}
let disposeVisibility = installWindowVisibility();
const activityHistory: Array<{ active: boolean; visible: boolean }> = [];
if (location.search.includes("native")) {
  EventTarget.prototype.addEventListener.call(window, WINDOW_ACTIVITY_EVENT, () => {
    activityHistory.push({active: isWindowActive(), visible: isWindowVisible()});
  });
}
await preloadLoadingOrb();
// A synthetic recording exercises cloned visualizer tracks without microphone access.
const recordingAudio = new AudioContext();
const recordingOutput = recordingAudio.createMediaStreamDestination();
const recordingStream = recordingOutput.stream;
const tone = recordingAudio.createOscillator();
tone.frequency.value = 440;
tone.connect(recordingOutput);
tone.start();
await recordingAudio.resume();
const capturedStreams: MediaStream[] = [];
navigator.mediaDevices.getUserMedia = async () => {
  const stream = recordingStream.clone();
  capturedStreams.push(stream);
  return stream;
};
let liveVoice: ReturnType<typeof useVoiceNote>;
let transcript = "";
let transcription: { bytes: number; duration: number; peak: number } | null = null;
let finishTranscription = () => {};
api.transcribeAudio = async audio => {
  const decoded = await recordingAudio.decodeAudioData(await audio.arrayBuffer());
  const data = decoded.getChannelData(0);
  let peak = 0;
  for (const sample of data) peak = Math.max(peak, Math.abs(sample));
  transcription = { bytes: audio.size, duration: decoded.duration, peak };
  return new Promise(resolve => { finishTranscription = () => resolve({ text: "Background recording survived" } as never); });
};
function VoiceSurface() {
  liveVoice = useVoiceNote(true, text => { transcript = text; });
  return <VoiceMemoLayer mode={liveVoice.state === "recording" || recording ? "recording" : "processing"}
    stream={liveVoice.stream ?? recordingStream} elapsedMs={liveVoice.elapsedMs || 1000} radius={24}
    anchor={{ right: 0, bottom: 0 }} onDiscard={() => {}} onSend={() => {}} onCancelProcessing={() => {}} />;
}
const root = createRoot(document.getElementById("root")!);
let recording = false;
const render = () => root.render(
  <main>
    {location.search.includes("native") && <div><h1>OpenTeam background QA</h1>
      <button onClick={() => (window as any).activityQA.cover()}>Cover test window</button>{" "}
      <button onClick={() => (window as any).activityQA.hide()}>Hide test window</button>{" "}
      <button onClick={() => (window as any).activityQA.quit()}>Finish native test</button></div>}
    <BotAvatarGlyph mode="idle" width={64} height={64} />
    <LoadingOrb size={32} />
    <LoadingOrb label="Explicitly paused" paused size={20} />
    <div style={{ position: "relative", width: 400, height: 80, marginTop: 250 }}>
      <VoiceSurface />
    </div>
    <Pollers />
  </main>
);
render();
Object.assign(window, {
  startRecording: () => { recording = true; render(); },
  startVoice: () => liveVoice.start(),
  stopVoice: () => liveVoice.stop(),
  cancelVoice: () => liveVoice.cancel(),
  finishTranscription: () => finishTranscription(),
  updateOffline: () => { updateUnavailable = true; refreshUpdate(); },
  updateIdle: () => { updateUnavailable = false; updateState = "idle"; refreshUpdate(); },
  disposeActivity: () => { root.render(null); disposeVisibility(); },
  reinstallActivity: () => { disposeVisibility = installWindowVisibility(); render(); },
  activityProbe: () => ({
    active: isWindowActive(),
    visible: isWindowVisible(),
    inactiveAttribute: document.documentElement.hasAttribute("data-window-inactive"),
    avatar: document.querySelector(".robot-avatar")?.getAttribute("data-avatar-mode"),
    paints: [...document.querySelectorAll("canvas")].map(canvas => paints.get(canvas) ?? 0),
    pluginReads,
    updateReads,
    recordingTrackLive: recordingStream.getAudioTracks().every(track => track.readyState === "live"),
    voiceState: liveVoice?.state,
    activityHistory,
    voiceElapsed: liveVoice?.elapsedMs,
    captureTracks: capturedStreams.flatMap(stream => stream.getTracks().map(track => track.readyState)),
    transcription, transcript, errors,
    resources: {
      intervals: intervals.size, frames: frames.size,
      observers: Object.fromEntries(Object.entries(observers).map(([key, value]) => [key, value.size])),
      listeners: Object.fromEntries([...listeners].filter(([key]) => /:focus:|:blur:|visibilitychange|openteam:window-activity-change/.test(key)).map(([key, value]) => [key, value.size])),
      visualizerTracks: [...visualizerTracks].filter(track => track.readyState === "live").length,
    },
  }),
  tickPollers: () => {
    for (const { callback, delay } of intervals.values()) {
      if ([1500, 30000, 60000].includes(delay)) callback();
    }
  },
  beginUpdate: () => beginUpdate(),
});
