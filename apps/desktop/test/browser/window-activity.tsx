import { createRoot } from "react-dom/client";
import { BotAvatarGlyph } from "../../src/renderer/components/openteam/avatar-picker-icons";
import VoiceMemoLayer from "../../src/renderer/components/openteam/voice-memo/voice-memo-layer";
import { LoadingOrb, preloadLoadingOrb } from "../../src/renderer/components/ui/loading-orb";
import { usePluginMentions } from "../../src/renderer/hooks/use-plugin-mentions";
import { useServerUpdateStatus } from "../../src/renderer/hooks/use-server-update-status";
import { api } from "../../src/renderer/client/openteam-api";
import { installWindowVisibility, isWindowActive, isWindowVisible } from "../../src/renderer/lib/window-visibility";
import "../../src/renderer/styles.css";

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
api.pluginComposer = async () => { pluginReads++; return { items: [] } as never; };
api.systemVersion = async () => ({ releaseVersion: "0.0.13" }) as never;
api.serverUpdateStatus = async () => { updateReads++; return { status: "idle" } as never; };
api.updateServer = async () => ({ status: "updating" }) as never;
let beginUpdate = () => {};
function Pollers() {
  usePluginMentions("test-bot");
  const { updateServer } = useServerUpdateStatus("0.0.13");
  beginUpdate = () => { void updateServer("0.0.14"); };
  return null;
}
installWindowVisibility();
await preloadLoadingOrb();
// A synthetic recording exercises cloned visualizer tracks without microphone access.
const recordingAudio = new AudioContext();
const recordingStream = recordingAudio.createMediaStreamDestination().stream;
const root = createRoot(document.getElementById("root")!);
let recording = false;
const render = () => root.render(
  <main>
    <BotAvatarGlyph mode="idle" width={64} height={64} />
    <LoadingOrb size={32} />
    <div style={{ position: "relative", width: 400, height: 80, marginTop: 250 }}>
      <VoiceMemoLayer mode={recording ? "recording" : "processing"} stream={recordingStream} elapsedMs={1000} radius={24}
        anchor={{ right: 0, bottom: 0 }} onDiscard={() => {}} onSend={() => {}} onCancelProcessing={() => {}} />
    </div>
    <Pollers />
  </main>
);
render();
Object.assign(window, {
  startRecording: () => { recording = true; render(); },
  activityProbe: () => ({
    active: isWindowActive(),
    visible: isWindowVisible(),
    inactiveAttribute: document.documentElement.hasAttribute("data-window-inactive"),
    avatar: document.querySelector(".robot-avatar")?.getAttribute("data-avatar-mode"),
    paints: [...document.querySelectorAll("canvas")].map(canvas => paints.get(canvas) ?? 0),
    pluginReads,
    updateReads,
    recordingTrackLive: recordingStream.getAudioTracks().every(track => track.readyState === "live"),
  }),
  tickPollers: () => {
    for (const { callback, delay } of intervals.values()) {
      if ([1500, 30000, 60000].includes(delay)) callback();
    }
  },
  beginUpdate: () => beginUpdate(),
});
